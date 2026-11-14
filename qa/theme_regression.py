import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def assert_theme(page, scheme):
    expected_bg = {'light': 'rgb(246, 245, 250)', 'dark': 'rgb(23, 20, 31)'}
    page.wait_for_function("(theme) => document.documentElement.dataset.theme === theme", arg=scheme)
    assert page.evaluate('getComputedStyle(document.documentElement).backgroundColor') == expected_bg[scheme]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path=os.environ.get('USPEVATOR_CHROME'),
        args=['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
    )
    page = browser.new_page(viewport={'width': 320, 'height': 568}, is_mobile=True, has_touch=True, color_scheme='dark')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(Path(sys.argv[1]).resolve().as_uri())
    assert_theme(page, 'dark')

    def choose(value):
        if not page.locator('#app-menu').evaluate('(element) => element.open'):
            page.locator('#app-menu > summary').tap()
        page.locator('#theme-choice').select_option(value)

    choose('light')
    assert_theme(page, 'light')
    page.reload()
    assert_theme(page, 'light')
    choose('dark')
    assert_theme(page, 'dark')
    page.reload()
    assert_theme(page, 'dark')
    page.locator('#focus-templates').tap()
    chooser = page.locator('#template-picker')
    assert chooser.is_visible()
    assert chooser.evaluate('(element) => getComputedStyle(element).backgroundColor') == 'rgb(35, 30, 46)'
    page.locator('#template-picker [data-action=close-template-picker]').tap()
    assert page.locator('#chart').is_visible()
    assert page.locator('#plan-details #planned-start').is_visible()
    assert page.locator('#plan-details #deadline').is_visible()
    zone = page.locator('.chart .zone-green')
    assert zone.evaluate('(element) => getComputedStyle(element).fill') == 'rgb(36, 63, 54)'
    assert not page.locator('#android-shade-timer').is_visible()
    page.evaluate('window.scrollTo(0,0)')
    choose('system')
    page.emulate_media(color_scheme='light')
    assert_theme(page, 'light')
    page.emulate_media(color_scheme='dark')
    assert_theme(page, 'dark')
    assert not errors, errors
    print('PASS system, light, dark, persistence, dark picker and chart at 320×568')
    browser.close()
