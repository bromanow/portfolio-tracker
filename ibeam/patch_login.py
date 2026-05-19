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

    _TARGET = 'Mobile Authenticator App'
    _found = False

    # Wait briefly for IBKR page to render after credential submission
    _t.sleep(3)

    # Strategy 1: native <select> element
    _selects = driver.find_elements(_By.TAG_NAME, 'select')
    for _s in _selects:
        _opts = [_o.text.strip() for _o in _s.find_elements(_By.TAG_NAME, 'option')]
        if _TARGET in _opts:
            logger.info('[patch] Selecting %s (native <select>)', _TARGET)
            _Sel(_s).select_by_visible_text(_TARGET)
            _t.sleep(1)
            _found = True
            break

    # Strategy 2: custom dropdown — find any element whose text matches exactly
    if not _found:
        for _xpath in (
            f"//*[normalize-space(text())='{_TARGET}']",
            f"//*[contains(text(),'{_TARGET}')]",
            f"//*[@value='{_TARGET}']",
        ):
            _els = driver.find_elements(_By.XPATH, _xpath)
            if _els:
                logger.info('[patch] Clicking %s (XPath: %s)', _TARGET, _xpath)
                _els[0].click()
                _t.sleep(1)
                _found = True
                break

    if _found:
        # Click Continue / Submit — try common selectors, last button wins
        for _css in ("button[type='submit']", "input[type='submit']",
                     ".btn-primary", "button.ibkr-btn", "button"):
            _btns = driver.find_elements(_By.CSS_SELECTOR, _css)
            if _btns:
                _btns[-1].click()
                _t.sleep(2)
                break
        logger.info('[patch] Device selection complete — proceeding with TOTP')
    else:
        logger.info('[patch] No device-selection dropdown found — proceeding normally')

except Exception as _e:
    logger.warning('[patch] 2FA device-select error (non-fatal): %s', _e)
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
