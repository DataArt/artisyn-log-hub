# Session attributes and cost advisor no longer fail on long sessions

Hook 2.31.1 runs the post-turn analysis `claude -p` without tools, MCP servers or skills, and passes the session's prompts as data. The evaluator can no longer act on the analysed session's own instructions, so it stops answering with prose ("Last evaluation failed"). Sessions blocked after three such failures are evaluated again.
