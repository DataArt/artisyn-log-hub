# Work Hub: remote git repositories, a credential vault and an admin overview

- New Connections page: add GitHub, GitLab, Azure DevOps or any git server with a generated SSH key, an uploaded key or a token; secrets stay in the vault and never reach the agent.
- A workspace can start as a clone of a remote repository, and Settings → Remotes attaches, tests and detaches remotes with a push policy.
- Closing a workstream can push its branch and links to the pull / merge request.
- All git traffic goes through a per-instance git proxy container that checks grants and the push policy.
- Admins (`WORK_HUB_ADMIN_EMAILS`) get a read-only resource overview: users, their workspaces, workstream counts and disk usage.
- Text in the agent terminal can be selected with a plain drag and copied (Ctrl+C, Ctrl+Shift+C, Ctrl+Insert, right-click), also when Work Hub is opened over plain http.
