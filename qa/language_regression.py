import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def check_language_and_chart(browser, source, system_locale, expected):
    page = browser.new_page(
        viewport={'width': 320, 'height': 568}, is_mobile=True, has_touch=True, locale=system_locale,
    )
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time=1_800_000_000_000)
    page.goto(source.as_uri())

    def text(selector):
        return page.locator(selector).inner_text().strip()

    def choose(language):
        menu = page.locator('#app-menu')
        if not menu.evaluate('(element) => element.open'):
            menu.locator('summary').tap()
        page.locator('#language-choice').select_option(language)
        menu.locator('summary').tap()

    def saved():
        return page.evaluate("JSON.parse(localStorage.getItem('uspevator_data'))")

    def check_chart():
        assert page.locator('#chart').is_visible()
        assert page.locator('#chart polygon').count() == 3
        assert page.evaluate("document.querySelector('.focus').nextElementSibling.matches('.buffer')")
        assert not page.locator('#plan-details').evaluate('(element) => element.open')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    assert page.locator('html').get_attribute('lang') == expected
    check_chart()
    choose('en')
    assert text('#primary-action') == 'Add task'
    page.locator('#app-menu summary').tap()
    page.locator('[data-action="help"]').tap()
    assert page.locator('#help-dialog').is_visible()
    assert '9:05' in text('#help-dialog .method')
    assert 'Critical Chain Project Management (CCPM)' in text('#help-dialog .method')
    page.locator('#help-dialog [data-action="close-help"]').last.tap()

    page.locator('#add-form [type="submit"]').tap()
    assert text('#add-error') == 'Enter a task name.'
    for name, optimistic, guarded in [('Готово', '2', '2'), ('Second task', '2', '4')]:
        page.locator('#task-name').fill(name)
        page.locator('#add-form [name="minTime"]').fill(optimistic)
        page.locator('#add-form [name="maxTime"]').fill(guarded)
        page.locator('#add-form [type="submit"]').tap()
        check_chart()
    page.locator('#primary-action').tap()
    running = saved()
    check_chart()
    assert text('#focus-kicker') == 'Task 1 of 2'
    assert text('#focus-heading') == 'Готово'
    choose('ru')
    assert text('#focus-kicker') == 'Задача 1 из 2'
    assert text('#focus-heading') == 'Готово'
    assert text('#finish-btn') == 'Готово'
    assert saved()['timer'] == running['timer']
    assert saved()['tasks'] == running['tasks']
    page.reload()
    assert page.locator('html').get_attribute('lang') == 'ru'
    check_chart()
    choose('system')
    assert page.locator('html').get_attribute('lang') == expected
    assert page.locator('#language-choice').input_value() == 'system'
    assert not errors, errors
    print(f'PASS {system_locale}: default, language switch on a running plan, reload and open chart')
    page.close()


if __name__ == '__main__':
    source = Path(sys.argv[1]).resolve()
    with sync_playwright() as playwright:
        for locale, expected in [('ru-RU', 'ru'), ('fr-FR', 'en')]:
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('USPEVATOR_CHROME'),
                args=['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
            )
            try:
                check_language_and_chart(browser, source, locale, expected)
            finally:
                browser.close()
