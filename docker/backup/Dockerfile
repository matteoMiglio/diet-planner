FROM alpine:3.22
RUN apk add --no-cache postgresql17-client restic tzdata ca-certificates jq
COPY lib.sh backup.sh restore-test.sh /usr/local/bin/
COPY crontab /etc/crontabs/root
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore-test.sh
# busybox crond in the foreground as PID 1; job output goes to `docker compose logs backup`.
CMD ["crond", "-f", "-l", "8"]
