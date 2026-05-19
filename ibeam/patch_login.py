"""
Build-time patch for IBeam's login handler.

IBKR shows a "Select Second Factor Device" dropdown on the login page.
The dropdown must be set to "Mobile Authenticator App" BEFORE clicking Login —
if the form is submitted without a device selected, IBKR defaults to IB Key
push notification and never shows the TOTP input field.

This script injects a Selenium snippet immediately BEFORE submit_form_el.click()
in step_login, so the device is selected as part of the pre-submission flow.
After the snippet runs, IBeam clicks Login normally and IBKR reveals the TOTP
input field, which IBeam's built-in pyotp handler fills in automatically.
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

# ── Code to inject BEFORE submit_form_el.click() ─────────────────────────────
TWO_FA_SELECT_SNIPPET = """\
# ── Pre-submit device-selection patch (injected by patch_login.py) ───────
# Select 'Mobile Authenticator App' before clicking Login.
# IBKR defaults to IB Key push if no device is selected at submission time.
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import Select as _Sel
    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')
    _TARGET = 'Mobile Authenticator App'
    _selects = driver.find_elements(_By.TAG_NAME, 'select')
    for _s in _selects:
        _opts = _s.find_elements(_By.TAG_NAME, 'option')
        _topt = next((o for o in _opts if _TARGET in o.text.strip()), None)
        if _topt:
            _val = _topt.get_attribute('value')
            _Sel(_s).select_by_value(_val)
            _t.sleep(0.5)
            _plog.info('[patch] Pre-submit: selected %s (value=%s)', _TARGET, _val)
            break
    else:
        _plog.info('[patch] Pre-submit: no device-select dropdown found — proceeding')
except Exception as _pe:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] Pre-submit selection failed: %s', _pe)
# ── end pre-submit device-selection patch ─────────────────────────────────
"""

# ── Anchor — the submit click line itself; we inject the snippet just before it
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

if '[patch] Pre-submit: selected' in content:
    print('Patch already applied — skipping.')
    sys.exit(0)

# Re-indent the snippet to match the indentation of the anchor line
lines = content.splitlines(keepends=True)
for i, line in enumerate(lines):
    if ANCHOR in line:
        indent = len(line) - len(line.lstrip())
        pad = ' ' * indent
        indented = '\n'.join(pad + l if l.strip() else '' for l in TWO_FA_SELECT_SNIPPET.splitlines())
        lines.insert(i, indented + '\n')
        break

with open(FILEPATH, 'w') as f:
    f.writelines(lines)

print(f'✓ Pre-submit device-selection patch applied to {FILEPATH}')
