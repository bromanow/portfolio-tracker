"""
Build-time patch for IBeam's login handler.

IBKR shows a "Select Second Factor Device" dropdown when multiple 2FA methods
are configured on an account.  IBeam's default login flow doesn't handle this
step — it times out waiting for a TOTP field that only appears after a device
is selected.

This script is run inside the Docker image at build time (RUN python3 patch_login.py).
It inserts a small Selenium snippet into login_handler.py that:
  1. Detects the device-selection <select> element
  2. Chooses "Mobile Authenticator App"
  3. Clicks Continue
  4. Then lets IBeam's normal TOTP handling proceed
"""

import sys

FILEPATH = '/srv/ibeam/src/handlers/login_handler.py'

# ── Code to inject ────────────────────────────────────────────────────────────
# Indentation is stripped here; the script re-indents it to match the anchor.
TWO_FA_SELECT_SNIPPET = """\
# ── 2FA device-selection patch (injected by patch_login.py) ──────────────
# When IBKR shows "Select Second Factor Device", pick Mobile Authenticator App
# so the normal TOTP prompt appears and pyotp can fill it in automatically.
# Uses two strategies: native <select> first, then XPath text search for
# custom div/button dropdowns (IBKR uses obfuscated CSS, not native selects).
try:
    import time as _t
    from selenium.webdriver.common.by import By as _By
    from selenium.webdriver.support.ui import Select as _Sel

    import logging as _logging
    _plog = _logging.getLogger('ibeam.patch')

    _TARGET = 'Mobile Authenticator App'
    _found = False

    # Wait for IBKR device-selection page to fully render
    _t.sleep(3)

    # The select IS a standard visible HTML <select> (confirmed from page inspection).
    # Use Selenium's Select class — the correct API for <select> elements.
    # (Earlier "not interactable" errors were because we tried before the 3s sleep.)
    _selects = driver.find_elements(_By.TAG_NAME, 'select')
    for _s in _selects:
        _opts = _s.find_elements(_By.TAG_NAME, 'option')
        _target_opt = next((o for o in _opts if _TARGET in o.text.strip()), None)
        if _target_opt:
            _val = _target_opt.get_attribute('value')
            _plog.info('[patch] Selecting %s (value=%s) via Selenium Select', _TARGET, _val)
            _Sel(_s).select_by_value(_val)
            _t.sleep(1)
            _found = True
            break

    if _found:
        # Log all visible buttons so we know what's on the page
        _all_btns = [b for b in driver.find_elements(_By.TAG_NAME, 'button') if b.is_displayed()]
        for _bi, _b in enumerate(_all_btns):
            _plog.info('[patch] Button[%d] type=%s text=%r', _bi, _b.get_attribute('type'), _b.text.strip())

        # Click Continue — try submit buttons first, then any visible button
        _clicked = False
        for _css in ("button[type='submit']", "input[type='submit']",
                     "button[type='button']", "button"):
            _btns = [b for b in driver.find_elements(_By.CSS_SELECTOR, _css)
                     if b.is_displayed()]
            if _btns:
                _btn = _btns[0]
                _plog.info('[patch] Clicking (%s) text=%r via JS click', _css, _btn.text.strip())
                # Use JS click — more reliable for IBKR's SPA event handlers
                driver.execute_script("arguments[0].click();", _btn)
                _clicked = True
                _t.sleep(3)
                break

        # Log what page looks like after clicking Continue
        try:
            _after = driver.find_element(_By.TAG_NAME, 'body').text
            _plog.info('[patch] After Continue body: %s', _after[:500])
        except Exception as _pe:
            _plog.info('[patch] Could not read post-Continue page: %s', _pe)

        _plog.info('[patch] Device selection complete (clicked=%s)', _clicked)
    else:
        _plog.info('[patch] No device-selection dropdown found — proceeding normally')

except Exception as _e:
    import logging as _logging
    _logging.getLogger('ibeam.patch').warning('[patch] 2FA device-select error (non-fatal): %s', _e)
# ── end 2FA device-selection patch ────────────────────────────────────────
"""

# ── Anchor — unique string that appears right before wait_and_identify_trigger ──
ANCHOR = 'trigger, target = wait_and_identify_trigger('

# ── Apply ─────────────────────────────────────────────────────────────────────
try:
    with open(FILEPATH, 'r') as f:
        content = f.read()
except FileNotFoundError:
    print(f'ERROR: {FILEPATH} not found — wrong IBeam version?')
    sys.exit(1)

if ANCHOR not in content:
    print(f'WARNING: anchor string not found in {FILEPATH}')
    print('IBeam version may have changed — skipping patch (container will still start).')
    sys.exit(0)

if '[patch] Selecting Mobile Authenticator App' in content:
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

print(f'✓ 2FA device-selection patch applied to {FILEPATH}')
