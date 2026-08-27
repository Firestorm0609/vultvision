#!/bin/bash
# VultFantasy automated database backup
BACKUP_DIR="/var/backups/vultfantasy"
mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/vultfantasy_${DATE}.sql.gz"

# Dump and compress (use postgres user for local auth)
sudo -u postgres pg_dump -d vultfantasy | gzip > "$BACKUP_FILE"

# Keep only last 7 backups
ls -t "$BACKUP_DIR"/vultfantasy_*.sql.gz | tail -n +8 | xargs -r rm

echo "[$(date)] Backup completed: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
