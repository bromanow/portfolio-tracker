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
        # Use keyboard navigation to trigger native browser change events.
        # IBKR uses a React-controlled select; keyboard interaction fires
        # native events that React's onChange handler can respond to.
        # Also try the React native-setter trick so state is updated.
        try:
            from selenium.webdriver.common.keys import Keys as _Keys
            # Re-read the current value and decide how many DOWN presses needed
            # Options: Select Type (0), IB Key (1), Mobile Authenticator App (2)
            # We want index 2 regardless of current position — reset first with HOME
            _s.send_keys(_Keys.HOME)
            _t.sleep(0.2)
            _s.send_keys(_Keys.DOWN)   # → IB Key
            _t.sleep(0.1)
            _s.send_keys(_Keys.DOWN)   # → Mobile Authenticator App
            _t.sleep(0.3)
            _plog.info('[patch] Keyboard-navigated to Mobile Authenticator App, current value=%s',
                       _s.get_attribute('value'))
        except Exception as _ke:
            _plog.info('[patch] Keyboard nav failed: %s', _ke)

        # Also apply the React native-setter so state is updated
        try:
            driver.execute_script(
                "var s=arguments[0];"
                "var ns=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;"
                "ns.call(s,'4');"
                "s.dispatchEvent(new Event('input',{bubbles:true}));"
                "s.dispatchEvent(new Event('change',{bubbles:true}));",
                _s
            )
            _plog.info('[patch] React native-setter fired')
        except Exception as _je:
            _plog.info('[patch] JS setter failed: %s', _je)

        # Wait to see if the page auto-advances without a button click
        _t.sleep(4)
        _after_body = ''
        try:
            _after_body = driver.find_element(_By.TAG_NAME, 'body').text
            _plog.info('[patch] After-select body (no click): %s', _after_body[:400])
        except Exception:
            pass

        # Only click a button if we're still on the device selection page
        if 'Select Second Factor Device' in _after_body:
            _plog.info('[patch] Page did not auto-advance — scanning for non-Login buttons')
            _all_btns = [b for b in driver.find_elements(_By.TAG_NAME, 'button') if b.is_displayed()]
            for _bi, _b in enumerate(_all_btns):
                _plog.info('[patch] Button[%d] type=%s text=%r', _bi,
                           _b.get_attribute('type'), _b.text.strip())
            # Click anything that is NOT the main Login button
            _non_login = [b for b in _all_btns
                          if b.text.strip().lower() not in ('login', 'log in')]
            if _non_login:
                _plog.info('[patch] Clicking non-Login button: %r', _non_login[0].text.strip())
                driver.execute_script("arguments[0].click();", _non_login[0])
                _t.sleep(2)
            else:
                _plog.info('[patch] No non-Login button found — will not click')

        _plog.info('[patch] Device selection done, handing off to wait_and_identify_trigger')
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
