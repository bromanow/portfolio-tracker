"""
Build-time patch for IBeam's login handler.

After IBeam submits credentials, IBKR shows a device-selection step.
The native <select> loads its options asynchronously. This patch waits
for options to appear, then interacts with IBKR's custom visible dropdown
(not just the hidden native <select>) so React registers the selection
and shows the TOTP input field.
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

# ── Code to inject AFTER submit_form_el.click() ──────────────────────────────
TWO_FA_SELECT_SNIPPET = """\
# ── Post-submit device-selection patch (injected by patch_login.py) ──────
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import Select as _Sel, WebDriverWait as _WDW
    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')
    _TARGET = 'Mobile Authenticator App'

    def _select_has_options(d):
        for _sel in d.find_elements(_By.TAG_NAME, 'select'):
            if any(o.text.strip() for o in _sel.find_elements(_By.TAG_NAME, 'option')):
                return _sel
        return False

    _s = _WDW(driver, 10).until(_select_has_options)
    _opts = _s.find_elements(_By.TAG_NAME, 'option')
    _opt_texts = [o.text.strip() for o in _opts]
    _plog.info('[patch] select options = %s', _opt_texts)

    # Log DOM structure around the select to understand the custom dropdown
    _dom = driver.execute_script(
        "var el=arguments[0], p=el.parentElement;"
        "for(var i=0;i<5&&p&&p.tagName!='BODY';i++) p=p.parentElement;"
        "return p?p.outerHTML.substring(0,1500):'';", _s)
    _plog.info('[patch] DOM near select: %s', _dom)

    _topt = next((o for o in _opts if _TARGET.lower() in o.text.strip().lower()), None)
    if _topt:
        _val = _topt.get_attribute('value')

        # Strategy 1: click the visible custom dropdown trigger, then click the option
        _done = False
        _trigger_xpaths = [
            '//*[normalize-space(.)="Select Type"]',
            '//*[@role="combobox"]',
            '//*[@role="button" and contains(@class,"select")]',
        ]
        for _xp in _trigger_xpaths:
            _triggers = driver.find_elements(_By.XPATH, _xp)
            for _tr in _triggers:
                if _tr.is_displayed():
                    _plog.info('[patch] Clicking trigger: <%s> %r class=%s',
                               _tr.tag_name, _tr.text.strip()[:40], _tr.get_attribute('class') or '')
                    _tr.click()
                    _t.sleep(0.5)
                    _mob_els = driver.find_elements(_By.XPATH,
                        '//*[contains(normalize-space(text()),"Authenticator")]')
                    for _me in _mob_els:
                        if _me.is_displayed():
                            _me.click()
                            _plog.info('[patch] Clicked visible option: %s', _me.text.strip())
                            _done = True
                            break
                    if _done:
                        break
            if _done:
                break

        if not _done:
            # Strategy 2: Selenium Select on native element
            try:
                _Sel(_s).select_by_value(_val)
                _plog.info('[patch] Selenium Select: value=%s', _val)
            except Exception:
                # Strategy 3: React-compatible JS setter
                driver.execute_script(
                    "var setter=Object.getOwnPropertyDescriptor("
                    "window.HTMLSelectElement.prototype,'value').set;"
                    "setter.call(arguments[0],arguments[1]);"
                    "arguments[0].dispatchEvent(new Event('change',{bubbles:true}));"
                    "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));",
                    _s, _val)
                _plog.info('[patch] JS React setter: value=%s', _val)

        _t.sleep(2)
        # Log available inputs to confirm TOTP field appeared
        _inputs = driver.find_elements(_By.TAG_NAME, 'input')
        _plog.info('[patch] Inputs after selection: %s',
            [(i.get_attribute('type'), i.get_attribute('placeholder') or i.get_attribute('id') or '',
              i.is_displayed()) for i in _inputs])
    else:
        _plog.warning('[patch] No matching option found in: %s', _opt_texts)
except Exception as _pe:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] Post-submit patch failed: %s', _pe)
# ── end post-submit device-selection patch ────────────────────────────────
"""

# ── Anchor — the submit click; we inject the snippet just AFTER it ────────────
ANCHOR = 'submit_form_el.click()'

# ── Apply ─────────────────────────────────────────────────────────────────────
try:
    with open(FILEPATH, 'r') as f:
        content = f.read()
except FileNotFoundError:
    print(f'ERROR: {FILEPATH} not found — wrong IBeam version?')
    sys.exit(1)

if ANCHOR not in content:
    print(f'WARNING: anchor "{ANCHOR}" not found in {FILEPATH}')
    print('IBeam version may have changed — skipping patch (container will still start).')
    sys.exit(0)

if '_select_has_options' in content:
    print('Patch already applied — skipping.')
    sys.exit(0)

lines = content.splitlines(keepends=True)
for i, line in enumerate(lines):
    if ANCHOR in line:
        indent = len(line) - len(line.lstrip())
        pad = ' ' * indent
        indented = '\n'.join(pad + l if l.strip() else '' for l in TWO_FA_SELECT_SNIPPET.splitlines())
        lines.insert(i + 1, indented + '\n')
        break

with open(FILEPATH, 'w') as f:
    f.writelines(lines)

print(f'✓ Post-submit device-selection patch applied to {FILEPATH}')
