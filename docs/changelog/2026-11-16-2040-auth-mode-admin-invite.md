# New auth mode `strict-managed`: admin-provisioned accounts

- New `AUTH_MODE=strict-managed`: no self sign-up; on first start the admin (`ADMIN_CONTACT_EMAIL`) gets an emailed set-password link.
- Admins create users in Admin Panel → Users (email, role, team); each user gets a 24 h one-time set-password link, which the admin can resend.
- "Forgot password?" works for every account; it is limited to 20 requests per IP per hour and each admin to 100 emails per hour, counted across all workers; the server refuses to start without a working SMTP relay.
- Password links are safer in every mode: the database keeps only a hash of each link, a weak or mistyped new password no longer uses the link up, a reset signs the account out everywhere, "Forgot password?" no longer reveals whether an account exists, and renaming an email retires the links sent to the old address.
