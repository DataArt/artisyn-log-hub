#!/bin/sh
# AgentBook sshd ForceCommand wrapper (/usr/local/share/agentbook/session.sh). Every SSH session
# (shell, exec and SFTP) starts here:
#   1. sources /run/agentbook/base.env, the container's own environment dumped by entry.sh, so a
#      session sees the same PATH and containerEnv as `devcontainer exec`; the session's own
#      HOME/USER/LOGNAME/SHELL are kept;
#   2. sources the tool-delivered Variables, /run/agentbook/env/session.env (one NAME='value' per
#      line, tmpfs only), exporting each;
#   3. runs what the client asked for, or a login shell.
# The env file format is fixed from version 1: a newer tool writes it, this script reads it.
_ab_home=$HOME
_ab_user=$USER
_ab_logname=$LOGNAME
_ab_shell=$SHELL
_ab_mail=$MAIL

if [ -r /run/agentbook/base.env ]; then
  . /run/agentbook/base.env
fi

HOME=$_ab_home
USER=$_ab_user
LOGNAME=$_ab_logname
SHELL=$_ab_shell
export HOME USER LOGNAME SHELL
if [ -n "$_ab_mail" ]; then MAIL=$_ab_mail; export MAIL; else unset MAIL; fi
unset _ab_home _ab_user _ab_logname _ab_shell _ab_mail
unset PWD OLDPWD
cd "$HOME" 2>/dev/null || cd /

if [ -r /run/agentbook/env/session.env ]; then
  set -a
  . /run/agentbook/env/session.env
  set +a
fi

if [ -n "$SSH_ORIGINAL_COMMAND" ]; then
  exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"
fi
exec "${SHELL:-/bin/sh}" -l
