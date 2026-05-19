"""
Build-time patch for IBeam's login handler.

After IBeam submits credentials, IBKR shows a device-selection step with a
custom React dropdown. This patch injects code AFTER submit_form_el.click()
that clicks IBKR's visible custom dropdown and selects "Mobile Authenticator App",
causing the TOTP input (id='xyz-field-silver-response') to appear.

IBeam's wait_and_identify_trigger then finds that input via
IBEAM_TWO_FA_EL_ID=ID@@xyz-field-silver-response, fills the TOTP code via
pyotp, and clicks Login — completing authentication natively.
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

TWO_FA_SNIPPET = """\
# ── Device-selection patch (injected by patch_login.py) ──────────────────
# After IBeam submits credentials, IBKR shows a device-selection dropdown.
# Clicks the visible custom dropdown and selects Mobile Authenticator App so
# the TOTP input appears. IBeam then handles TOTP natively via pyotp.
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import WebDriverWait as _WDW
    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')

    def _select_has_options(d):
        for _sel in d.find_elements(_By.TAG_NAME, 'select'):
            if any(o.text.strip() for o in _sel.find_elements(_By.TAG_NAME, 'option')):
                return _sel
        return False

    _s = _WDW(driver, 10).until(_select_has_options)
    _plog.info('[patch] Device options: %s',
               [o.text.strip() for o in _s.find_elements(_By.TAG_NAME, 'option')])

    _done = False
    for _xp in ['//*[normalize-space(.)="Select Type"]', '//*[@role="combobox"]']:
        for _tr in driver.find_elements(_By.XPATH, _xp):
            if _tr.is_displayed():
                _tr.click()
                _t.sleep(0.5)
                for _me in driver.find_elements(_By.XPATH,
                        '//*[contains(normalize-space(text()),"Authenticator")]'):
                    if _me.is_displayed():
                        _me.click()
                        _plog.info('[patch] Device selected: %s', _me.text.strip())
                        _done = True
                        break
                if _done:
                    break
        if _done:
            break

    if not _done:
        _plog.warning('[patch] Could not find visible device dropdown')
except Exception as _pe:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] Device selection failed: %s', _pe)
# ── end device-selection patch ────────────────────────────────────────────
"""

ANCHOR = 'submit_form_el.click()'

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
        indented = '\n'.join(pad + l if l.strip() else '' for l in TWO_FA_SNIPPET.splitlines())
        lines.insert(i + 1, indented + '\n')
        break

with open(FILEPATH, 'w') as f:
    f.writelines(lines)

print(f'✓ Device-selection patch applied to {FILEPATH}')
