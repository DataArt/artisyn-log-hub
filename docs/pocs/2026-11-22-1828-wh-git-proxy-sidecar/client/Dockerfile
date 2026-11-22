# Stand-in for a workspace container: stock git, no ssh client, no credentials.
FROM alpine:3.20
RUN apk add --no-cache git && adduser -D workhub
USER workhub
RUN git config --global user.name ws && git config --global user.email ws@x
