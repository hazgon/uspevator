import os
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


MINUTE = 60_000


def instant(value):
    return datetime.fromisoformat(f'2026-11-14T{value}:00+00:00')


def timestamp(value):
    return int(instant(value).timestamp() * 1000)


def check(source, browser, language, width, android):
    page = browser.new_page(
        viewport={'width': width, 'height': 750}, is_mobile=width < 600,
        has_touch=width < 600, locale=language, timezone_id='UTC',
        color_scheme='dark' if width < 600 else 'light',
    )
    page.clock.install(time=instant('08:00'))
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    storage = 'test-plan' if android else 'uspevator_data'
    if android:
        page.add_init_script("""
            window.UspevatorAndroid = {
              systemLanguage: () => 'en', theme: () => 'system', systemDark: () => true,
              readPlan: () => localStorage.getItem('test-plan') || '',
              writePlan: (expected, data) => {
                if ((localStorage.getItem('test-plan') || '') !== expected) return 'conflict';
                localStorage.setItem('test-plan', data);
                return 'ok';
              },
              canUndoFinish: () => false, keepScreen: () => true, shadeTimer: () => false,
              shadePermissionPending: () => false, signalVolume: () => 35, testSignal: () => true
            };
        """)
    page.goto(source.as_uri())
    panel = page.locator('#plan-details')
    start, finish = page.locator('#planned-start'), page.locator('#deadline')
    earliest, guarded = page.locator('#earliest-time'), page.locator('#guarded-time')
    latest = page.locator('#latest-start')

    def saved():
        return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', storage)

    def add(base, upper):
        page.locator('#task-name').fill('Test task')
        page.locator('#add-form [name="minTime"]').fill(str(base))
        page.locator('#add-form [name="maxTime"]').fill(str(upper))
        page.locator('#add-form button[type="submit"]').click()

    def check_open():
        expect(panel).to_be_visible()
        expect(finish).to_be_visible()
        expect(page.locator('#queue-details')).to_have_attribute('open', '')
        expect(page.locator('#templates')).to_have_attribute('open', '')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    check_open()
    expect(start).to_be_visible()
    expect(earliest).to_have_text('—')
    assert not panel.locator('details, select, input[type="date"], input[type="datetime-local"]').count()
    add(40, 60)
    start.fill('0810')
    start.press('Tab')
    expect(start).to_have_value('08:10')
    finish.fill('09:00')
    expect(earliest).to_have_text('08:50')
    expect(guarded).to_have_text('09:10')
    expect(latest).to_have_text('08:00')
    expect(page.locator('#focus-promise-time')).to_have_text('09:10')
    expected = 'Гарантированно закончим к 09:00,' if language == 'ru-RU' else "You'll finish by 09:00"
    expect(page.locator('#deadline-phrase')).to_have_text(expected)
    expect(page.locator('#earliest-duration')).to_have_text('40 мин' if language == 'ru-RU' else '40 min')
    expect(page.locator('#guarded-duration')).to_have_text('1 ч' if language == 'ru-RU' else '1 h')
    assert saved()['window'] == {'start': None, 'finish': timestamp('09:00'), 'startMinute': 490}

    start.fill('07:55')
    expect(earliest).to_have_text('08:35')
    expect(guarded).to_have_text('08:55')
    expect(latest).to_have_text('08:00')
    finish.fill('09:20')
    expect(latest).to_have_text('08:20')
    expect(earliest).to_have_text('08:35')
    page.reload()
    expect(start).to_have_value('07:55')
    expect(finish).to_have_value('09:20')
    check_open()

    finish.fill('25:00')
    expect(page.locator('#deadline-answer')).to_be_hidden()
    finish.press('Tab')
    expect(page.locator('#deadline-error')).to_be_visible()
    assert saved()['window']['finish'] == timestamp('09:20')
    finish.fill('')
    expect(page.locator('#deadline-answer')).to_be_hidden()
    start.fill('23:45')
    finish.fill('00:45')
    expect(earliest).to_have_text('00:25')
    expect(guarded).to_have_text('00:45')
    expect(latest).to_have_text('23:45')
    expect(page.locator('#guarded-day')).to_be_hidden()

    page.locator('#start-now').click()
    expect(start).to_have_value('')
    expect(guarded).to_have_text('09:00')
    start.fill('06:00')
    finish.fill('08:45')
    expect(page.locator('#latest-start-note')).to_be_visible()
    expect(page.locator('#focus-promise-time')).to_have_text('07:00')
    page.locator('#primary-action').click()
    expect(start).to_be_hidden()
    expect(page.locator('#deadline-answer')).to_be_hidden()
    check_open()
    running = saved()
    assert running['timer']['phase'] == 'running'
    assert running['timer']['startedAt'] == running['timer']['runningSince']
    assert running['window']['finish'] == timestamp('08:45')
    expect(page.locator('#protected-time')).to_have_text('09:00')
    expect(page.locator('#deadline-fit')).to_have_attribute('data-tone', 'yellow')
    page.locator('#primary-action').click()
    assert saved()['timer']['phase'] == 'paused'
    page.clock.fast_forward(10 * MINUTE)
    expect(page.locator('#protected-time')).to_have_text('09:00')
    expect(guarded).to_have_text('09:10')
    assert saved()['window']['finish'] == timestamp('08:45')
    page.reload()
    check_open()
    expect(page.locator('#protected-time')).to_have_text('09:00')
    page.locator('#finish-btn').click()
    expect(page.locator('#earliest-label')).to_have_text('Фактический финиш' if language == 'ru-RU' else 'Actual finish')
    check_open()

    legacy = saved()
    legacy['window'] = {'start': timestamp('08:00'), 'finish': timestamp('09:30')}
    page.evaluate('([key, value]) => localStorage.setItem(key, JSON.stringify(value))', [storage, legacy])
    page.reload()
    expect(finish).to_have_value('09:30')
    finish.focus()
    finish.press('Tab')
    assert saved()['window'] == legacy['window']
    check_open()
    page.locator('#repeat-btn').click()
    expect(start).to_have_value('')
    expect(finish).to_have_value('')
    check_open()

    add(2120, 2625)
    start.fill('17:45')
    finish.fill('14:30')
    expect(earliest).to_have_text('05:45')
    expect(guarded).to_have_text('14:30')
    expect(latest).to_have_text('17:45')
    expected_day = 'через два дня' if language == 'ru-RU' else 'in two days'
    expect(page.locator('#guarded-day')).to_have_text(expected_day)
    expect(page.locator('#deadline-phrase')).to_contain_text(expected_day)
    check_open()
    assert not errors, errors
    print(f'PASS {language}, {width}px, android={android}: open sections, live calculations, midnight, long plan, reload, start and pause')
    page.close()


if __name__ == '__main__':
    cases = [(sys.argv[1], 'ru-RU', 320, False), (sys.argv[1], 'en-US', 1040, False)]
    if len(sys.argv) > 2:
        cases.append((sys.argv[2], 'en-US', 360, True))
    with sync_playwright() as playwright:
        for path, language, width, android in cases:
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('USPEVATOR_CHROME'),
                args=['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
            )
            try:
                check(Path(path).resolve(), browser, language, width, android)
            finally:
                browser.close()
