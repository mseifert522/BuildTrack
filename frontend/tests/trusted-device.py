"""Browser regression: AUDIT_URL=http://127.0.0.1:5177 python tests/trusted-device.py

Requires Python Playwright. All API responses are fixtures; no live accounts.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("AUDIT_URL", "http://127.0.0.1:5177")
EXPIRY = (datetime.now(timezone.utc) + timedelta(days=60)).strftime("%Y-%m-%d %H:%M:%S")
DEVICE = "test-device-approval"
USER = {"id": "remember-test", "name": "Test User", "email": "remember@example.invalid",
        "role": "super_admin", "force_password_reset": True}
SESSION = {"token": "fixture-session", "user": USER, "device_token": DEVICE,
           "trusted_device_expires_at": EXPIRY}
BUTTON = re.compile("One Touch Access")


def storage(page):
    return page.evaluate("() => Object.fromEntries(Object.entries(localStorage))")


with sync_playwright() as p:
    browser = p.chromium.launch(
        channel=os.environ.get("PLAYWRIGHT_CHANNEL", "msedge" if os.name == "nt" else "chromium"),
        headless=True)
    try:
        for outcome in ["network", 503, 429, 403, 401, "new-approval"]:
            context = browser.new_context()
            page = context.new_page()
            page.goto(BASE + "/login")
            page.wait_for_load_state("networkidle")
            page.evaluate("""([token, expiry]) => {
                localStorage.setItem('bt_device_token', token);
                localStorage.setItem('bt_device_trusted_until', expiry);
            }""", [DEVICE, EXPIRY])
            page.reload()
            page.wait_for_load_state("networkidle")

            def reject(route):
                if outcome == "network":
                    route.abort("internetdisconnected")
                else:
                    if outcome == "new-approval":
                        # Simulate another tab finishing 2FA while an old request is pending.
                        page.evaluate("localStorage.setItem('bt_device_token', 'new-approval')")
                    route.fulfill(status=401 if outcome == "new-approval" else outcome,
                                  json={"error": "Simulated login failure"})

            page.route("**/api/auth/trusted-device-login", reject)
            page.get_by_role("button", name=BUTTON).click()
            expect(page.get_by_text("Trusted device sign-in failed" if outcome == "network"
                                    else "Simulated login failure", exact=True)).to_be_visible()
            current = storage(page)
            if outcome == 401:
                assert "bt_device_token" not in current
                assert "bt_device_trusted_until" not in current
                expect(page.get_by_role("button", name=BUTTON)).to_have_count(0)
            else:
                assert current["bt_device_token"] == ("new-approval" if outcome == "new-approval" else DEVICE)
                assert current["bt_device_trusted_until"] == EXPIRY
                expect(page.get_by_role("button", name=BUTTON)).to_be_enabled()
                page.reload()
                expect(page.get_by_role("button", name=BUTTON)).to_be_visible()
            context.close()
            print("PASS: trusted-device failure handling:", outcome)

        context = browser.new_context()
        page = context.new_page()
        login_requests = []

        def api(route):
            url = route.request.url
            if url.endswith("/api/auth/login"):
                body = route.request.post_data_json
                login_requests.append(body)
                assert body["trust_device"] is True
                route.fulfill(json=SESSION if body.get("twofa_code") == "123456"
                              else {"requires_2fa": True})
            elif url.endswith("/api/auth/trusted-device-login"):
                assert route.request.post_data_json["device_token"] == DEVICE
                route.fulfill(json=SESSION)
            else:
                route.fulfill(json=USER if url.endswith("/api/auth/me") else [])

        page.route("**/api/**", api)
        page.goto(BASE + "/login")
        page.wait_for_load_state("networkidle")
        page.locator("#buildtrack-email").fill(USER["email"])
        page.locator("#buildtrack-password").fill("fixture-password")
        page.get_by_role("button", name="Trust this device after verification", exact=True).click()
        page.get_by_role("button", name="Sign In", exact=True).click()
        expect(page.get_by_role("checkbox")).to_be_checked()
        page.get_by_placeholder("000000").fill("123456")
        page.get_by_role("button", name="Verify and Sign In", exact=True).click()
        page.wait_for_url("**/change-password")
        assert len(login_requests) == 2
        assert storage(page)["bt_device_token"] == DEVICE
        for _ in range(2):
            # End the short session without changing the independent device approval.
            page.evaluate("""() => {
                for (const key of ['token','user','auth_session_started_at',
                    'auth_last_activity_at','auth_last_refresh_at']) localStorage.removeItem(key);
            }""")
            page.goto(BASE + "/login")
            page.get_by_role("button", name=BUTTON).click()
            page.wait_for_url("**/change-password")
            assert storage(page)["bt_device_token"] == DEVICE
        assert len(login_requests) == 2, "Repeated one-click sign-in must not request fresh 2FA"
        context.close()
        print("PASS: remember preference survives 2FA; approval survives reload and repeated one-click login")

        # Both saved mechanisms must appear as one control, then fall back to
        # trusted-device approval after the seven-day quick-access token expires.
        context = browser.new_context()
        page = context.new_page()
        page.goto(BASE + "/login")
        page.wait_for_load_state("networkidle")
        page.evaluate("""([device, expiry]) => {
            localStorage.setItem('bt_device_token', device);
            localStorage.setItem('bt_device_trusted_until', expiry);
            localStorage.setItem('bt_mobile_quick_access_token', 'fixture-quick');
            localStorage.setItem('bt_mobile_quick_access_expires_at', expiry);
            localStorage.setItem('bt_mobile_quick_access_user_label', 'Test User');
        }""", [DEVICE, EXPIRY])
        page.reload()
        expect(page.get_by_role("button", name=BUTTON)).to_have_count(1)
        expect(page.get_by_role("button", name="Continue on this trusted device", exact=True)).to_have_count(0)
        page.route("**/api/auth/mobile-quick-access",
                   lambda route: route.fulfill(status=401, json={"error": "Quick access expired",
                                                                 "reset_quick_access": True}))
        page.get_by_role("button", name=BUTTON).click()
        expect(page.get_by_text("Quick access expired", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name=BUTTON)).to_have_count(1)
        assert storage(page)["bt_device_token"] == DEVICE
        page.route("**/api/**", api)
        page.get_by_role("button", name=BUTTON).click()
        page.wait_for_url("**/change-password")
        context.close()
        print("PASS: one access button with both approvals and trusted-device fallback")
    finally:
        browser.close()
