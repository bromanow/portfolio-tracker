"""
Build-time patch for IBeam's login handler.

After IBeam submits credentials, IBKR presents a device-selection dropdown
and a TOTP input field. IBeam's wait_and_identify_trigger cannot locate the
TOTP input on the IBKR page using its built-in selectors.

This patch handles the ENTIRE 2FA flow inline (after submit_form_el.click()):
  1. Wait for device-selection <select> options to load asynchronously
  2. Click IBKR's visible custom dropdown → click "Mobile Authenticator App"
  3. Wait for the TOTP input to appear (placeholder "Mobile Authenticator App Code")
  4. Generate a TOTP code via pyotp and fill it in
  5. Click the Login button to submit everything

After the patch clicks Login, wait_and_identify_trigger only needs to detect
the SUCCESS condition (redirect to the IBKR portal URL), which it handles natively.
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

# ── Code to inject AFTER submit_form_el.click() ──────────────────────────────
TWO_FA_SNIPPET = """\
# ── Full 2FA patch (injected by patch_login.py) ──────────────────────────
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import WebDriverWait as _WDW
    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')

    # ── Step 1: wait for device-select options to load ────────────────────
    def _select_has_options(d):
        for _sel in d.find_elements(_By.TAG_NAME, 'select'):
            if any(o.text.strip() for o in _sel.find_elements(_By.TAG_NAME, 'option')):
                return _sel
        return False

    _s = _WDW(driver, 10).until(_select_has_options)
    _plog.info('[patch] Device options: %s',
               [o.text.strip() for o in _s.find_elements(_By.TAG_NAME, 'option')])

    # ── Step 2: click the visible custom dropdown, then the target option ─
    _dev_done = False
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
                        _dev_done = True
                        break
                if _dev_done:
                    break
        if _dev_done:
            break

    if not _dev_done:
        _plog.warning('[patch] Custom dropdown not found — device may not be selected')

    # ── Step 3: wait for TOTP input to appear ────────────────────────────
    _t.sleep(1)
    _totp_el = None
    for _inp in driver.find_elements(_By.TAG_NAME, 'input'):
        _ph = (_inp.get_attribute('placeholder') or '').lower()
        if _inp.is_displayed() and any(w in _ph for w in ('code', 'authenticator', 'otp')):
            _totp_el = _inp
            _plog.info('[patch] TOTP input: placeholder=%r id=%r',
                       _inp.get_attribute('placeholder'), _inp.get_attribute('id'))
            break

    # ── Step 4: generate and fill TOTP ───────────────────────────────────
    if _totp_el is not None and key:
        try:
            import pyotp as _pyotp
            _code = _pyotp.TOTP(key).now()
            _totp_el.clear()
            _totp_el.send_keys(_code)
            _plog.info('[patch] TOTP filled (%d digits)', len(_code))
        except Exception as _te:
            _plog.warning('[patch] TOTP fill failed: %s', _te)
    else:
        _plog.warning('[patch] TOTP input=%s key=%s — skipping fill',
                      'found' if _totp_el else 'NOT FOUND',
                      'present' if key else 'MISSING')

    # ── Step 5: click Login to submit everything ──────────────────────────
    _t.sleep(0.5)
    _login_btns = [b for b in driver.find_elements(
        _By.XPATH, '//button[@type="submit" or normalize-space(text())="Login"]')
        if b.is_displayed()]
    if _login_btns:
        _login_btns[0].click()
        _plog.info('[patch] Clicked Login — waiting for portal redirect')
    else:
        _plog.warning('[patch] Login button not found')

except Exception as _pe:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] 2FA patch failed: %s', _pe)
# ── end 2FA patch ─────────────────────────────────────────────────────────
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
        indented = '\n'.join(pad + l if l.strip() else '' for l in TWO_FA_SNIPPET.splitlines())
        lines.insert(i + 1, indented + '\n')
        break

with open(FILEPATH, 'w') as f:
    f.writelines(lines)

print(f'✓ Full 2FA patch applied to {FILEPATH}')
