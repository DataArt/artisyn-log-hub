# New auth mode `strict-managed`: admin-provisioned accounts

- New `AUTH_MODE=strict-managed`: no self sign-up; on first start the admin (`ADMIN_CONTACT_EMAIL`) gets an emailed set-password link.
- Admins create users in Admin Panel → Users (email, role, team); each user gets a 24 h one-time set-password link, which the admin can resend.
- "Forgot password?" works for every account; outgoing emails are limited to 20 per IP per hour; the server refuses to start without a working SMTP relay.
