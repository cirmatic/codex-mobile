# Start a real bridge at 3030 with PROJECT_ROOTS=<repo>/.runtime/projects.
# Optional CODEX_MOBILE_HOME=<repo>/.runtime/codex-home for isolated history.
# This test calls the configured model and approves only its dedicated test conversation.
import os, time, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base='http://127.0.0.1:3030'
token=Path('.runtime/access-token').read_text().strip()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':390,'height':844}, device_scale_factor=1)
    page.goto(base, wait_until='networkidle')
    assert page.get_by_text('把灵感').is_visible(), page.content()[:1000]
    page.get_by_label('电脑连接密钥').fill(token)
    page.get_by_role('button', name='连接电脑').click()
    page.wait_for_timeout(1000)
    assert page.get_by_text('选择项目，开始对话').is_visible(), page.content()[:2000]
    page.get_by_role('button', name='选择项目，开始对话').click()
    page.wait_for_timeout(300)
    assert page.get_by_role('dialog', name='选择项目目录').is_visible()
    # Root lists the allowed project root, then enter it and create a deterministic test directory.
    root_entry=page.locator('.directory-list button').first
    root_entry.click(); page.wait_for_timeout(200)
    directory='e2e-'+str(int(time.time()))
    page.get_by_label('新目录名称').fill(directory)
    page.get_by_role('button', name='新建目录').click()
    expect(page.locator('.directory-path')).to_contain_text(directory)
    page.get_by_role('button', name='在此目录开始会话').click(); page.wait_for_timeout(1000)
    assert page.get_by_role('textbox', name='消息').is_enabled()
    page.get_by_role('textbox', name='消息').fill('请在当前目录创建 smoke.py，用 Python 计算 sum(range(1,11))，将结果以 JSON 对象 {\"sum\": 55} 写入 result.json，并打印 SMOKE_RESULT=55。然后实际运行 python3 smoke.py，核对输出。只做这个测试，不使用子代理，不访问其他项目。')
    page.get_by_role('button', name='发送消息').click()
    # Approve only this test's file/command operations. Wait for actual evidence, not a fixed delay.
    target=Path('.runtime/projects')/directory/'result.json'
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        approve=page.get_by_role('button', name='允许这次')
        if approve.count() and approve.is_visible() and approve.is_enabled():
            approve.click()
        page.wait_for_timeout(1000)
        if target.exists() and json.loads(target.read_text()).get('sum')==55 and page.locator('.working').count()==0:
            break
    body=page.locator('body').inner_text()
    assert target.exists() and json.loads(target.read_text()).get('sum')==55, body[-4000:]
    assert '55' in body and (target.parent/'smoke.py').exists(), body[-3000:]
    assert page.locator('.working').count()==0, body[-3000:]
    ctx=page.context; ctx.set_offline(True); page.wait_for_timeout(1000); ctx.set_offline(False)
    page.reload(wait_until='networkidle')
    expect(page.locator('.cwd')).to_contain_text(directory)
    expect(page.locator('.markdown').last).to_contain_text('55')
    page.screenshot(path='artifacts/e2e-mobile.png', full_page=True)
    print('E2E_OK')
    print(body[-1000:])
    browser.close()
