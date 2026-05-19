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

    # Wait briefly for IBKR page to render after credential submission
    _t.sleep(3)

    # --- Page inspection (helps debug IBKR's dropdown structure) ---
    try:
        _body_text = driver.find_element(_By.TAG_NAME, 'body').text
        _plog.info('[patch] Page body (first 600 chars): %s', _body_text[:600])
        _selects = driver.find_elements(_By.TAG_NAME, 'select')
        _plog.info('[patch] Found %d <select> element(s)', len(_selects))
        for _i, _s in enumerate(_selects):
            _plog.info('[patch] select[%d] id=%s visible=%s value=%s',
                       _i, _s.get_attribute('id'), _s.is_displayed(), _s.get_attribute('value'))
            for _o in _s.find_elements(_By.TAG_NAME, 'option'):
                _plog.info('[patch]   option text=%r value=%r', _o.text.strip(), _o.get_attribute('value'))
    except Exception as _dbg_e:
        _plog.info('[patch] Page inspection failed: %s', _dbg_e)

    # Strategy 1: set hidden <select> value via JS AND fire React/Angular-friendly events
    try:
        _selects = driver.find_elements(_By.TAG_NAME, 'select')
        for _s in _selects:
            _opts = _s.find_elements(_By.TAG_NAME, 'option')
            _target_opt = next((o for o in _opts if _TARGET in o.text.strip()), None)
            if _target_opt:
                _val = _target_opt.get_attribute('value')
                _plog.info('[patch] S1: setting select value=%s via JS', _val)
                driver.execute_script(
                    "var s=arguments[0], v=arguments[1];"
                    "var nativeSet=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;"
                    "nativeSet.call(s,v);"
                    "s.dispatchEvent(new Event('input',{bubbles:true}));"
                    "s.dispatchEvent(new Event('change',{bubbles:true}));",
                    _s, _val
                )
                _t.sleep(1)
                _found = True
                break
    except Exception as _e1:
        _plog.info('[patch] S1 JS approach failed: %s', _e1)

    # Strategy 2: open the visible custom dropdown then click the option.
    # IBKR uses a styled overlay; the native select is hidden.
    # Step A: try to click any visible trigger near the hidden select
    # Step B: then look for visible "Mobile Authenticator App" option
    try:
        # Step A — open the dropdown by clicking element with id=xyz-field-bronze-response
        # (IBeam's TWO_FA_SELECT_EL_ID points here as the trigger)
        _trigger_ids = ['xyz-field-bronze-response', 'two-factor-select', 'deviceSelect']
        for _tid in _trigger_ids:
            _trigger_els = driver.find_elements(_By.ID, _tid)
            _visible_triggers = [e for e in _trigger_els if e.is_displayed()]
            if _visible_triggers:
                _plog.info('[patch] S2: clicking dropdown trigger id=%s', _tid)
                _visible_triggers[0].click()
                _t.sleep(1)
                break

        # Step B — click the visible option
        for _xpath in (
            f"//*[normalize-space(text())='{_TARGET}']",
            f"//*[contains(text(),'{_TARGET}')]",
            f"//*[@data-value='{_TARGET}']",
            f"//*[@title='{_TARGET}']",
        ):
            _candidates = driver.find_elements(_By.XPATH, _xpath)
            _visible = [e for e in _candidates if e.is_displayed()]
            if _visible:
                _plog.info('[patch] S2: clicking visible %s (xpath=%s)', _TARGET, _xpath)
                _visible[0].click()
                _t.sleep(1)
                _found = True
                break
    except Exception as _e2:
        _plog.info('[patch] S2 visible-click approach failed: %s', _e2)

    if _found:
        # Click Continue / Submit — visible buttons only
        for _css in ("button[type='submit']", "input[type='submit']",
                     ".btn-primary", "button.ibkr-btn", "button"):
            _btns = [b for b in driver.find_elements(_By.CSS_SELECTOR, _css)
                     if b.is_displayed()]
            if _btns:
                _plog.info('[patch] Clicking Continue button (%s)', _css)
                _btns[-1].click()
                _t.sleep(2)
                break
        _plog.info('[patch] Device selection complete — proceeding with TOTP')
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
