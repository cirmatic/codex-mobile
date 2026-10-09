#!/usr/bin/env python3
"""Copy native rollouts with backup and collision checks. Stop old mobile service first.
Never overwrite destination sessions or install a source SQLite database.
"""
import argparse, hashlib, json, os, shutil, sqlite3, tempfile
from pathlib import Path
from datetime import datetime

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def metadata(p):
    with p.open() as f:
        for line in f:
            d=json.loads(line)
            if d.get('type')=='session_meta' and d['payload'].get('id'):
                return d['payload']
    raise ValueError(f'缺少 session_meta: {p}')

def migrate(source, target, backups):
    source=Path(source).resolve();target=Path(target).resolve();backups=Path(backups).resolve()
    if source==target: raise ValueError('源目录与目标目录相同')
    files=[p for folder in ('sessions','archived_sessions') for p in (source/folder).rglob('*.jsonl')]
    sources={}
    for p in files:
        mid=metadata(p)['id']
        if mid in sources: raise ValueError(f'源目录中存在重复会话 ID：{mid}')
        sources[mid]=p
    existing={}
    for folder in ('sessions','archived_sessions'):
        for p in (target/folder).rglob('*.jsonl'):
            mid=metadata(p)['id'];existing.setdefault(mid,[]).append(p)
    # A previous verified copy may have been appended by Codex after a partial deployment.
    migrated={}
    if backups.exists():
        for manifest in backups.glob('*/manifest.json'):
            report=json.loads(manifest.read_text())
            if report.get('source')==str(source) and report.get('target')==str(target):
                for entry in report.get('copied',[]):migrated[entry['id']]=entry['sha256']
    for mid,p in sources.items():
        if mid in existing and migrated.get(mid)==digest(p):continue
        for dest in existing.get(mid,[]):
            if digest(p)!=digest(dest):raise ValueError(f'同 ID 会话内容不同，保留两端原文件并停止：{mid}')
        dest=target/p.relative_to(source)
        if dest.exists() and digest(p)!=digest(dest):raise ValueError(f'目标路径已存在不同内容：{dest}')
    backups.mkdir(parents=True,exist_ok=True,mode=0o700)
    backup=Path(tempfile.mkdtemp(prefix=datetime.now().strftime('%Y%m%d-%H%M%S-'),dir=backups))
    for folder in ('sessions','archived_sessions'):
        if (source/folder).exists():shutil.copytree(source/folder,backup/folder)
    for db in source.glob('state_*.sqlite'):
        with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as src, sqlite3.connect(backup/db.name) as dst:src.backup(dst)
    copied=[];skipped=[]
    for mid,p in sources.items():
        if mid in existing:skipped.append(mid);continue
        dest=target/p.relative_to(source);dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists():skipped.append(mid);continue
        saved=backup/p.relative_to(source)
        if digest(p)!=digest(saved):raise ValueError('旧服务仍在写入会话，请停止后重试')
        fd,temp=tempfile.mkstemp(prefix='.migration-',dir=dest.parent)
        try:
            with os.fdopen(fd,'wb') as out:out.write(saved.read_bytes());out.flush();os.fsync(out.fileno())
            os.link(temp,dest)
        finally:os.unlink(temp)
        copied.append({'id':mid,'path':str(dest),'sha256':digest(dest)})
    report={'source':str(source),'target':str(target),'backup':str(backup),'copied':copied,'skipped':skipped}
    (backup/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    for p in backup.rglob('*'):
        if p.is_file():p.chmod(0o600)
        elif p.is_dir():p.chmod(0o700)
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--target',required=True);parser.add_argument('--backups',required=True)
    a=parser.parse_args()
    try:print(json.dumps(migrate(a.source,a.target,a.backups),ensure_ascii=False,indent=2))
    except Exception as e:parser.exit(1,f'迁移停止：{e}\n')
