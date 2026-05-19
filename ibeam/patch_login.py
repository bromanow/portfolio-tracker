"""
Build-time patch for IBeam's login handler.

IBKR's login page shows username + password first. After submitting those
credentials, IBKR presents a "Select Second Factor Device" dropdown. This
patch injects a Selenium snippet AFTER submit_form_el.click() so it waits
for that dropdown to appear and selects "Mobile Authenticator App" before
IBeam's wait_and_identify_trigger looks for the TOTP input.
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

# ── Code to inject AFTER submit_form_el.click() ──────────────────────────────
TWO_FA_SELECT_SNIPPET = """\
# ── Post-submit device-selection patch (injected by patch_login.py) ──────
# After submitting credentials, IBKR shows a device-selection dropdown.
# We wait for it, pick "Mobile Authenticator App", then let IBeam handle TOTP.
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import Select as _Sel, WebDriverWait as _WDW
    from selenium.webdriver.support import expected_conditions as _EC
    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')
    _TARGET = 'Mobile Authenticator App'
    try:
        _WDW(driver, 8).until(_EC.presence_of_element_located((_By.TAG_NAME, 'select')))
        _selects = driver.find_elements(_By.TAG_NAME, 'select')
        _found = False
        for _s in _selects:
            _opts = _s.find_elements(_By.TAG_NAME, 'option')
            _topt = next((o for o in _opts if _TARGET in o.text.strip()), None)
            if _topt:
                _val = _topt.get_attribute('value')
                try:
                    _Sel(_s).select_by_value(_val)
                except Exception:
                    driver.execute_script(
                        "arguments[0].value = arguments[1];"
                        "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));"
                        "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));",
                        _s, _val
                    )
                _t.sleep(1)
                _plog.info('[patch] Post-submit: selected %s (value=%s)', _TARGET, _val)
                _found = True
                break
        if not _found:
            _plog.info('[patch] Post-submit: <select> appeared but no "%s" option', _TARGET)
    except Exception as _we:
        _plog.info('[patch] Post-submit: no device-select within 8s — proceeding (%s)', _we)
except Exception as _pe:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] Post-submit selection failed: %s', _pe)
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

if '[patch] Post-submit: selected' in content:
    print('Patch already applied — skipping.')
    sys.exit(0)

# Re-indent the snippet to match the indentation of the anchor line
lines = content.splitlines(keepends=True)
for i, line in enumerate(lines):
    if ANCHOR in line:
        indent = len(line) - len(line.lstrip())
        pad = ' ' * indent
        indented = '\n'.join(pad + l if l.strip() else '' for l in TWO_FA_SELECT_SNIPPET.splitlines())
        # Insert AFTER the anchor line so we run post-submit
        lines.insert(i + 1, indented + '\n')
        break

with open(FILEPATH, 'w') as f:
    f.writelines(lines)

print(f'✓ Post-submit device-selection patch applied to {FILEPATH}')
