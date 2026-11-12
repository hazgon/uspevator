import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def saved_tasks(state):
    return [task['id'] for task in state['tasks']]


def run(browser, source, width, height):
    mobile = width < 600
    page = browser.new_page(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, locale='ru-RU')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time=1_800_000_000_000)
    page.goto(source.as_uri())

    def read():
        return page.evaluate("JSON.parse(localStorage.getItem('uspevator_data'))")

    def box(selector):
        bounds = page.locator(selector).bounding_box()
        assert bounds and bounds['x'] >= 0 and bounds['y'] >= 0, (selector, bounds)
        assert bounds['x'] + bounds['width'] <= width + 1, (selector, bounds)
        assert bounds['y'] + bounds['height'] <= height + 1, (selector, bounds)
        return bounds

    def tap(selector):
        bounds = box(selector)
        x = bounds['x'] + bounds['width'] / 2
        y = bounds['y'] + bounds['height'] / 2
        assert page.evaluate('([s,x,y])=>document.querySelector(s).contains(document.elementFromPoint(x,y))',
                             [selector, x, y]), (selector, bounds)
        if mobile:
            page.touchscreen.tap(x, y)
        else:
            page.mouse.click(x, y)

    tasks = [
        dict(id=name, name='Задача ' + name, minTime=3, maxTime=5,
             firstStep='Первый шаг', workedMs=0, referenceMs=0, remainingMs=None, done=False)
        for name in ('A', 'B', 'C')
    ]
    fixture = dict(
        version=1, tasks=tasks, templates=[], pastRuns=[],
        timer=dict(phase='idle', startedAt=None, finishedAt=None, runningSince=None,
                   pausedSince=None, activeId=None, baselineMs=0, bufferMs=0, points=[]),
        window=dict(start=None, finish=None), settings=dict(sound=False, logLevel='INFO')
    )
    page.evaluate("(fixture)=>localStorage.setItem('uspevator_data',JSON.stringify(fixture))", fixture)
    page.reload()
    skip = '#skip-btn'
    assert not page.locator(skip).is_visible()
    tap('#primary-action')
    page.clock.fast_forward(20_000)
    before = read()
    assert before['timer']['phase'] == 'running' and before['timer']['activeId'] == 'A'
    assert abs(box(skip)['y'] - box('#finish-btn')['y']) <= 1
    tap(skip)
    after = read()
    assert saved_tasks(after) == ['B', 'C', 'A']
    assert after['timer']['activeId'] == 'B' and after['timer']['phase'] == 'running'
    assert after['timer']['startedAt'] == before['timer']['startedAt']
    assert after['timer']['baselineMs'] == before['timer']['baselineMs']
    assert after['timer']['bufferMs'] == before['timer']['bufferMs']
    deferred = after['tasks'][-1]
    assert deferred['workedMs'] >= 20_000 and deferred['workedMs'] == deferred['referenceMs']
    assert not deferred['done']
    assert page.locator('#focus-heading').inner_text() == 'Задача B'
    assert not page.locator('#action-dialog').is_visible()
    assert 'в конец очереди' in page.locator('#toast').inner_text()

    page.clock.fast_forward(5_000)
    tap('#primary-action')
    paused = read()
    page.clock.fast_forward(8_000)
    assert abs(box(skip)['y'] - box('#primary-action')['y']) <= 1, {
        key: box(key) for key in (skip, '#primary-action', '#finish-btn', '.focus-buttons')
    }
    tap(skip)
    after = read()
    assert saved_tasks(after) == ['C', 'A', 'B']
    assert after['timer']['activeId'] == 'C' and after['timer']['phase'] == 'paused'
    assert after['timer']['pausedSince'] == paused['timer']['pausedSince']
    assert after['timer']['runningSince'] is None
    assert after['tasks'][-1]['workedMs'] == paused['tasks'][0]['workedMs']
    page.reload()
    assert read() == after
    assert page.locator('#focus-heading').inner_text() == 'Задача C'
    assert page.locator(skip).is_visible()

    tap('#finish-btn')
    page.clock.fast_forward(500)
    assert read()['timer']['activeId'] == 'A'
    assert read()['tasks'][1]['workedMs'] == deferred['workedMs']
    tap('#finish-btn')
    assert read()['timer']['activeId'] == 'B'
    assert not page.locator(skip).is_visible()
    assert not errors, errors
    print(f'PASS {width}x{height}: visible tap, running/paused rotation, clock, reload, last task', flush=True)
    page.close()


if __name__ == '__main__':
    source = Path(sys.argv[1]).resolve()
    with sync_playwright() as playwright:
        for size in ((320, 568), (360, 720), (1050, 800)):
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('USPEVATOR_CHROME'),
                args=['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
            )
            try:
                run(browser, source, *size)
            finally:
                browser.close()
