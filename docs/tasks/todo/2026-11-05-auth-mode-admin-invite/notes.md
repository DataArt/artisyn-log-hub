# Notes

## 2026-11-05 — Raw idea (moved from requirements.md)

Raw idea (verbatim, translated from Russian), with the clarifications given while scratching:

> Auth mode 5: the admin creates users manually from the admin panel; the password is sent to the user
> by email (SMTP config is mandatory for this mode); the admin's email is set in the config; on the first
> start the admin's password is sent to them by email.
>
> I.e. a strictly manual access-management mode.
>
> Plus all the usual stuff — "I forgot my password", a reset link. We never send a password, only a
> reset link. Also a per-IP rate limit on sending. "Just send me a reset link" is the standard way for
> everything, including the initial admin bootstrap.

Original (Russian): «режим авторизации 5 когда админ заводит пользователей руками из админки; пароль
высылается почтой (smtp config must have); email админа прописывается в конфиге; пароль высылается ему
на почту при первом запуске» · «т.е. такой жестко ручной режим управления доступом» · «ну и вот это всё
обычное — я забыл пароль, ссылка на reset — пароль не посылаем, только ссылку на ресет; ещё rate limit на
посылку на IP; просто пошли мне ссылку на ресет — это стандартный способ для всего, в том числе
начального бутстрепа админа».
