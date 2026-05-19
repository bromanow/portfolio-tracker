# Custom IBeam image — extends voyz/ibeam:latest with a login patch that
# handles IBKR's "Select Second Factor Device" dropdown.
#
# When an IBKR account has both IB Key and a Mobile Authenticator App
# configured, the portal shows a device-selection step after password
# submission.  The stock IBeam image doesn't handle this step and times out.
# patch_login.py inserts a Selenium snippet that picks "Mobile Authenticator App"
# so the normal pyotp TOTP flow can proceed.

FROM voyz/ibeam:latest

# Copy and run the patch at image build time
COPY patch_login.py /tmp/patch_login.py
RUN python3 /tmp/patch_login.py
