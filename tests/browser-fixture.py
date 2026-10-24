from pathlib import Path
from urllib.parse import urlencode
import os, time, json
from playwright.sync_api import sync_playwright, expect
base=os.environ.get('TEST_URL','http://127.0.0.1:3031')
runtime=Path(os.environ.get('TEST_RUNTIME','.runtime/fixture'))
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,accept_downloads=True)
    page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(base,wait_until='networkidle')
    page.screenshot(path='artifacts/login-mobile.png')
    page.get_by_label('电脑连接密钥').fill('incorrect')
    page.get_by_role('button',name='连接电脑').click()
    expect(page.get_by_role('alert')).to_contain_text('不正确')
    page.get_by_label('电脑连接密钥').fill((runtime/'access-token').read_text().strip())
    page.get_by_role('button',name='连接电脑').click()
    expect(page.locator('.welcome .primary')).to_be_enabled()
    expect(page.get_by_role('combobox', name='选择模型')).to_be_visible()
    page.get_by_role('combobox', name='选择模型').select_option('fixture-model')
    page.screenshot(path='artifacts/welcome-mobile.png')
    page.locator('.welcome .primary').click()
    page.locator('.directory-list button').first.click()
    page.get_by_text('显示隐藏目录（以 . 开头）').click()
    expect(page.locator('.directory-list button').filter(has_text='.fixture-hidden')).to_have_count(1)
    name='browser-'+str(int(time.time()))
    page.get_by_label('新目录名称').fill(name)
    page.get_by_role('button',name='新建目录').click()
    expect(page.locator('.directory-path')).to_contain_text(name)
    page.get_by_role('button',name='使用此工作区').click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    expect(page.locator('.cwd')).to_contain_text(name)
    expect(page.get_by_role('textbox',name='消息',exact=True)).to_be_disabled()
    expect(page.locator('.thread-link')).to_have_count(0)
    selected_workspace=Path(page.evaluate("localStorage.getItem('cm-workspace')"))
    payload='实验结果：42\n'.encode('utf-8')
    (selected_workspace/'报告.txt').write_bytes(payload)
    (selected_workspace/'.secret.txt').write_text('blocked')
    (selected_workspace/'.hidden-dir').mkdir()
    (selected_workspace/'.hidden-dir'/'inside.txt').write_text('blocked')
    (selected_workspace/'secret-link').symlink_to('.secret.txt')
    (selected_workspace/'figures').mkdir()
    (selected_workspace/'figures'/'plot.txt').write_text('plot')
    page.get_by_role('button',name='浏览工作区文件').click()
    file_dialog=page.get_by_role('dialog',name='浏览工作区文件')
    expect(file_dialog.get_by_role('link',name='下载 报告.txt')).to_be_visible()
    expect(file_dialog.get_by_text('.secret.txt')).to_have_count(0)
    expect(file_dialog.get_by_text('.hidden-dir')).to_have_count(0)
    expect(file_dialog.get_by_text('secret-link')).to_have_count(0)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'file browser horizontal overflow'
    page.screenshot(path='artifacts/file-browser-mobile.png')
    with page.expect_download() as download_info:
        file_dialog.get_by_role('link',name='下载 报告.txt').click()
    download=download_info.value
    assert download.suggested_filename=='报告.txt'
    assert Path(download.path()).read_bytes()==payload
    file_dialog.get_by_role('button',name='figures').click()
    expect(file_dialog.get_by_role('link',name='下载 plot.txt')).to_be_visible()
    file_dialog.get_by_role('button',name='上一级').click()
    expect(file_dialog.get_by_role('link',name='下载 报告.txt')).to_be_visible()
    page.get_by_role('button',name='关闭文件浏览').click()
    for index in range(105):
        (selected_workspace/f'zz-scroll-{index:03d}.txt').write_text(str(index))
    page.get_by_role('button',name='浏览工作区文件').click()
    expect(file_dialog.locator('.file-row')).to_have_count(100)
    before_scroll=file_dialog.bounding_box()
    assert before_scroll['y'] >= 12 and before_scroll['y']+before_scroll['height'] <= 844-12
    assert before_scroll['height'] <= 680
    assert page.locator('.file-list').evaluate('(element) => element.scrollHeight > element.clientHeight')
    page.locator('.file-list').evaluate('(element) => element.scrollTop = element.scrollHeight')
    expect(file_dialog.get_by_role('link',name='下载 zz-scroll-104.txt')).to_be_visible(timeout=5000)
    expect(file_dialog.locator('.file-row')).to_have_count(107)
    last_download=file_dialog.get_by_role('link',name='下载 zz-scroll-104.txt')
    last_download.scroll_into_view_if_needed()
    assert page.locator('.file-list').evaluate('(element) => element.scrollTop > 0')
    assert file_dialog.evaluate('(element) => element.scrollTop')==0
    after_scroll=file_dialog.bounding_box()
    assert abs(before_scroll['height']-after_scroll['height']) < 1
    assert abs(before_scroll['y']-after_scroll['y']) < 1
    page.screenshot(path='artifacts/file-browser-scrolled-mobile.png')
    file_dialog.get_by_role('button',name='关闭文件浏览').click()
    page.get_by_role('button',name='浏览工作区文件').click()
    expect(file_dialog.locator('.file-row')).to_have_count(100)
    assert page.locator('.file-list').evaluate('(element) => element.scrollTop')==0
    page.get_by_role('button',name='关闭文件浏览').click()
    def file_url(workspace,path):
        return base+'/api/files/download?'+urlencode({'workspace':str(workspace),'path':path})
    assert ctx.request.get(file_url(selected_workspace,'报告.txt')).body()==payload
    for denied in ['.secret.txt','.hidden-dir/inside.txt','secret-link']:
        assert ctx.request.get(file_url(selected_workspace,denied)).status==403
    fixture_root=Path(os.environ['TEST_PROJECT_ROOT'])
    assert ctx.request.get(file_url(fixture_root,'private-note.txt')).status==403
    assert ctx.request.get(file_url(selected_workspace,'../private-note.txt')).status==400
    page.get_by_role('button',name='在此工作区新建会话').click()
    expect(page.get_by_role('textbox',name='消息',exact=True)).to_be_enabled()
    expect(page.locator('.conversation-jump')).to_have_count(0)
    model=page.get_by_role('combobox',name='选择模型')
    effort=page.get_by_role('combobox',name='推理强度')
    model.select_option('fixture-model');effort.select_option('high')
    model.select_option('fixture-fast');expect(effort).to_have_value('low')
    model.select_option('fixture-model');effort.select_option('high')
    page.get_by_role('textbox',name='消息',exact=True).fill('进行一次计算')
    page.get_by_role('button',name='发送消息').click()
    expect(page.locator('.working')).to_be_visible()
    expect(effort).to_be_disabled()
    thread_id=page.evaluate("localStorage.getItem('cm-thread')")
    ctx.set_offline(True)
    page.wait_for_timeout(4000)
    ctx.set_offline(False)
    page.reload(wait_until='networkidle')
    expect(page.locator('.markdown')).to_contain_text(['正在计算','实验结果'])
    expect(page.locator('.markdown strong')).to_have_text('42')
    expect(page.locator('.working')).not_to_be_visible()
    assert page.evaluate("localStorage.getItem('cm-thread')")==thread_id
    expect(page.get_by_role('combobox',name='推理强度')).to_have_value('high')
    recorded=json.loads((runtime/'history.json').read_text())[thread_id]
    assert recorded['reasoningEffort']=='high' and recorded['model']=='fixture-model'
    page.get_by_role('textbox',name='消息',exact=True).fill('长会话测试')
    page.get_by_role('button',name='发送消息').click()
    expect(page.locator('.markdown').last).to_contain_text('长会话测试完成',timeout=10000)
    pane=page.locator('.conversation')
    assert pane.evaluate('(element) => element.scrollHeight - element.clientHeight > 500')
    header_y=page.locator('header').bounding_box()['y']
    composer_y=page.locator('.composer-area').bounding_box()['y']
    expect(page.get_by_role('button',name='跳转到会话顶部')).to_be_visible()
    pane.evaluate('(element) => {const max=element.scrollHeight-element.clientHeight; element.scrollTop=max*0.4}')
    page.wait_for_timeout(100)
    expect(page.get_by_role('button',name='跳转到会话顶部')).to_be_visible()
    pane.evaluate('(element) => {const max=element.scrollHeight-element.clientHeight; element.scrollTop=max*0.7}')
    expect(page.get_by_role('button',name='跳转到最新消息')).to_be_visible()
    page.screenshot(path='artifacts/jump-button-mobile.png')
    page.get_by_role('button',name='跳转到最新消息').click()
    page.wait_for_function("() => {const e=document.querySelector('.conversation'); return e.scrollHeight-e.scrollTop-e.clientHeight < 30}")
    expect(page.get_by_role('button',name='跳转到会话顶部')).to_be_visible()
    page.get_by_role('button',name='跳转到会话顶部').click()
    page.wait_for_function("() => document.querySelector('.conversation').scrollTop < 30")
    expect(page.get_by_role('button',name='跳转到最新消息')).to_be_visible()
    assert abs(page.locator('header').bounding_box()['y']-header_y)<1
    assert abs(page.locator('.composer-area').bounding_box()['y']-composer_y)<1
    page.get_by_role('textbox',name='消息',exact=True).fill('审批测试')
    page.get_by_role('button',name='发送消息').click()
    expect(page.get_by_role('button',name='允许这次')).to_be_visible()
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('button',name='允许这次')).to_be_visible()
    page.screenshot(path='artifacts/approval-mobile.png')
    page.get_by_role('button',name='允许这次').click()
    expect(page.locator('.markdown').last).to_contain_text('已批准')
    page.get_by_role('textbox',name='消息',exact=True).fill('再次审批')
    page.get_by_role('button',name='发送消息').click()
    page.get_by_role('button',name='拒绝',exact=True).click()
    expect(page.locator('.markdown').last).to_contain_text('已拒绝')
    page.get_by_role('textbox',name='消息',exact=True).fill('等待长任务')
    page.get_by_role('button',name='发送消息').click()
    page.get_by_role('button',name='停止',exact=False).click()
    expect(page.get_by_text('本轮已停止，可以继续发送消息。')).to_be_visible()
    page.get_by_role('textbox',name='消息',exact=True).fill('草稿内容')
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('textbox',name='消息',exact=True)).to_have_value('草稿内容')
    first_workspace=page.evaluate("localStorage.getItem('cm-workspace')")
    page.locator('.cwd').click()
    page.locator('.directory-list button').first.click()
    second='other-'+str(int(time.time()))
    page.get_by_label('新目录名称').fill(second);page.get_by_role('button',name='新建目录').click()
    expect(page.locator('.directory-path')).to_contain_text(second)
    page.get_by_role('button',name='使用此工作区').click()
    expect(page.locator('.thread-link')).to_have_count(0)
    expect(page.get_by_role('textbox',name='消息',exact=True)).to_have_value('')
    page.get_by_role('button',name='在此工作区新建会话').click()
    page.get_by_role('textbox',name='消息',exact=True).fill('第二目录草稿')
    page.locator('.cwd').click()
    page.locator('.recent-workspaces button').filter(has_text=first_workspace).click()
    page.get_by_role('button',name='使用此工作区').click()
    expect(page.get_by_role('textbox',name='消息',exact=True)).to_have_value('草稿内容')
    assert page.evaluate("localStorage.getItem('cm-thread')")==thread_id
    expect(page.locator('.thread-link')).to_have_count(1)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile horizontal overflow'
    page.screenshot(path='artifacts/chat-mobile.png')
    page.set_viewport_size({'width':1440,'height':960})
    page.screenshot(path='artifacts/chat-desktop.png')
    assert not errors, errors
    # API boundary checks share the authenticated browser cookie.
    assert ctx.request.get(base+'/api/directories?path=/etc').status==400
    assert ctx.request.post(base+'/api/directories',data={'parent':'/etc','name':'bad'},headers={'Origin':base}).status==400
    assert ctx.request.post(base+'/api/directories',data={'parent':'/etc','name':'bad'},headers={'Origin':'https://evil.example'}).status==403
    assert ctx.request.get(base+'/manifest.webmanifest').status==200
    assert ctx.request.get(base+'/icon-192.png').status==200
    # An unauthorized new browser cannot access the directory list.
    other=browser.new_context();assert other.request.get(base+'/api/config').status==401
    assert other.request.get(file_url(selected_workspace,'报告.txt')).status==401
    other.close()
    print(json.dumps({'result':'PASS','checks':['login','directory create/select','workspace file browsing','authenticated download','hidden and custom denied paths','streaming Markdown','offline/reconnect','approval reconnect','approve','decline','interrupt','draft persistence','mobile layout','desktop layout','directory boundary','CSRF origin','unauthenticated API','PWA assets'],'threadId':thread_id},ensure_ascii=False))
    browser.close()
