import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

qa = Path(__file__).resolve().parent
path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else qa.parent / 'uspevator.html'
desktop = len(sys.argv) > 2 and sys.argv[2] == 'desktop'
viewport = {'width': 1000, 'height': 850} if desktop else {'width': 360, 'height': 720}
chrome = Path(os.environ.get('USPEVATOR_CHROME', str(qa / 'chromium' / 'chromium')))
minute = 60_000

def draft_task(i, prefix):
    return dict(id='task-'+str(i), name=prefix+str(i), minTime=2.5, maxTime=4.25,
                firstStep='Первый шаг '+str(i), workedMs=0, referenceMs=0, remainingMs=None, done=False)

def fixture(n, done=False):
    tasks = [draft_task(i,'Текущая задача ') for i in range(n)]
    template = [{k:v for k,v in draft_task(i,'Из шаблона ').items()
                if k in ('name','minTime','maxTime','firstStep')} for i in range(16)]
    start = 1_800_000_000_000
    if done:
        for task in tasks:
            task.update(done=True, workedMs=minute)
    return dict(version=1, tasks=tasks, templates=[
        dict(id='morning', name='Утро', tasks=template),
        dict(id='empty', name='Пустой шаблон', tasks=[])],
        timer=dict(phase='done' if done else 'idle', startedAt=start if done else None,
            finishedAt=start+n*minute if done else None, runningSince=None, activeId=None,
            baselineMs=int(n*2.5*minute) if done else 0, bufferMs=int(n*1.75*minute) if done else 0, points=[]),
        window=dict(start=start, finish=start+90*minute), settings=dict(sound=False, logLevel='INFO'))

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=str(chrome),
        args=['--no-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote','--disable-gpu'])
    page=browser.new_page(viewport=viewport, has_touch=not desktop, is_mobile=not desktop, locale='ru-RU')
    errors=[]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(path.as_uri())
    def seed(n,done=False):
        page.evaluate("(state)=>localStorage.setItem('uspevator_data',JSON.stringify(state))",fixture(n,done))
        page.reload()
    def el(selector): return page.locator(selector).first
    def state(): return page.evaluate("JSON.parse(localStorage.uspevator_data)")
    def tap(selector):
        if desktop: el(selector).click()
        else: el(selector).tap()
    def in_view(selector):
        box=el(selector).bounding_box()
        assert box and box['y'] >= 0 and box['y']+box['height'] <= viewport['height']+1, (selector,box)
        return box
    def tap_visible(selector):
        box=in_view(selector)
        x,y=box['x']+box['width']/2,box['y']+box['height']/2
        assert page.evaluate('([s,x,y])=>document.querySelector(s).contains(document.elementFromPoint(x,y))',[selector,x,y])
        if desktop: page.mouse.click(x,y)
        else: page.touchscreen.tap(x,y)
    def open_picker():
        y=page.evaluate('scrollY')
        tap_visible('#focus-templates')
        assert el('#template-picker').is_visible()
        assert page.evaluate('scrollY')==y
    def confirm(): tap('#dialog-confirm')
    def open_templates(): tap('#queue-tools [data-action=show-templates]')
    def open_row(id):
        if not el('[data-template='+id+']').evaluate('(el)=>el.open'):
            tap('[data-template='+id+']>summary')
    page.evaluate('localStorage.clear()')
    page.reload()
    open_picker()
    assert 'Шаблонов с задачами пока нет' in el('#template-picker-description').inner_text()
    assert el('#picker-import').is_visible() and el('#picker-add').is_visible()
    tap_visible('#template-picker [data-action=close-template-picker]')
    seed(0)
    old=state()
    open_picker()
    assert page.locator('#template-choices button').count()==1
    tap_visible('#template-picker [data-action=close-template-picker]')
    assert state()==old
    open_picker()
    tap_visible('#template-choices [data-id=morning]')
    applied=state()
    assert not el('#template-picker').is_visible()
    assert el('#primary-action').inner_text().strip()=='Начать'
    assert len(applied['tasks'])==16 and applied['tasks'][0]['firstStep']=='Первый шаг 0'
    assert applied['timer']['phase']=='idle' and applied['templates']==old['templates']
    print('PASS real visible tap opens picker, empty/saved choices, selection creates draft')
    if desktop:
        seed(4)
        open_row('morning')
        source=in_view('[data-template=morning] [data-drag=template]')
        dest=in_view('#pending-list li[data-drop-task]')
        page.mouse.move(source['x']+source['width']/2,source['y']+source['height']/2)
        page.mouse.down()
        page.mouse.move(dest['x']+dest['width']/2,dest['y']+6,steps=18)
        page.mouse.up()
        assert state()['tasks'][0]['name']=='Из шаблона 0'
        assert len(state()['templates'][0]['tasks'])==16
        print('PASS real desktop drag inserts before the target, template stays intact')
    else:
        seed(20)
        old=state()
        open_templates()
        page.wait_for_timeout(180)
        in_view('[data-template=morning]>summary')
        open_row('morning')
        in_view('[data-template=morning] [data-action=apply-template]')
        tap('[data-template=morning] [data-action=apply-template]')
        tap('#dialog-form [data-action=close-dialog]')
        assert state()==old
        tap('[data-template=morning] [data-action=apply-template]')
        confirm()
        assert len(state()['tasks'])==16 and state()['tasks'][0]['firstStep']=='Первый шаг 0'
        assert state()['tasks'][0]['minTime']==2.5 and state()['window']==old['window']
        print('PASS 16-task template actions fit without scrolling; cancel and apply preserve expected state')
        tap('#pending-list [data-action=edit]')
        el('#dialog-body [name=name]').fill('Изменённая задача')
        confirm()
        assert state()['templates'][0]['tasks'][0]['name']=='Из шаблона 0'
        tap('#save-template')
        el('#dialog-body [name=name]').fill('Копия')
        confirm()
        page.wait_for_timeout(180)
        copied=state()['templates'][-1]['id']
        in_view('[data-template="'+copied+'"] [data-action=apply-template]')
        assert state()['templates'][-1]['tasks'][0]['name']=='Изменённая задача'
        tap('[data-template=morning] [data-action=overwrite-template]')
        confirm()
        assert state()['templates'][0]['tasks'][0]['name']=='Изменённая задача'
        open_row('empty')
        assert el('[data-template=empty] [data-action=apply-template]').is_disabled()
        tap('[data-template="'+copied+'"] [data-action=copy-template-task]')
        assert len(state()['tasks'])==17 and len(state()['templates'][-1]['tasks'])==16
        print('PASS edit, save and reveal, overwrite, single-task copy, empty template guard')
        tap('#new-list')
        tap('[data-action=save-and-new]')
        el('#dialog-body [name=name]').fill('Снимок')
        confirm()
        assert state()['tasks']==[] and state()['templates'][-1]['name']=='Снимок'
        page.evaluate('scrollTo(0,0)')
        open_picker()
        with page.expect_file_chooser() as picker: tap_visible('#picker-import')
        picker.value.set_files({'name':'invalid.json','mimeType':'application/json','buffer':b'invalid json'})
        el('#template-picker-error').wait_for(state='visible')
        assert el('#template-picker').is_visible()
        legacy={'templates':[{'name':'Из старого JSON','tasks':[{'name':'Задача','optimisticEstimate':3,'pessimisticEstimate':4}]}]}
        legacy_file={'name':'legacy.json','mimeType':'application/json','buffer':json.dumps(legacy,ensure_ascii=False).encode()}
        old=state()
        with page.expect_file_chooser() as picker: tap('#picker-import')
        picker.value.set_files(legacy_file)
        tap('#dialog-form [data-action=close-dialog]')
        assert el('#template-picker').is_visible() and state()==old
        with page.expect_file_chooser() as picker: tap_visible('#picker-import')
        picker.value.set_files(legacy_file)
        confirm()
        assert el('#template-picker').is_visible()
        el('#template-choices button').filter(has_text='Из старого JSON').wait_for()
        assert state()['templates'][0]['tasks'][0]['maxTime']==4 and state()['tasks']==[]
        tap_visible('#template-picker [data-action=close-template-picker]')
        with page.expect_download() as transfer: tap('#template-export')
        exported=json.loads(transfer.value.path().read_text())
        assert exported['templates'][0]['tasks'][0]['minTime']==3
        print('PASS save-and-new, invalid JSON feedback, cancel import, legacy estimates, export')
        seed(2,True)
        old=state()
        open_templates()
        open_row('morning')
        tap('[data-template=morning] [data-action=apply-template]')
        confirm()
        assert state()['window']==old['window'] and state()['timer']['phase']=='idle'
        assert len(state()['pastRuns'])==1 and len(state()['tasks'])==16
        assert all(t['workedMs']==0 and not t['done'] for t in state()['tasks'])
        page.reload()
        assert len(state()['tasks'])==16 and len(state()['pastRuns'])==1
        print('PASS template after completed plan preserves history and window across reload')
    assert not errors,errors
    browser.close()
