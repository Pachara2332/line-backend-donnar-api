ALTER TABLE line_users ADD COLUMN IF NOT EXISTS picture_url TEXT;
ALTER TABLE line_users ADD COLUMN IF NOT EXISTS profile_synced_at TIMESTAMPTZ;

ALTER TABLE rich_menu_publications ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE rich_menu_publications ADD COLUMN IF NOT EXISTS image_content_type TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rich_menu_single_draft
  ON rich_menu_publications((status)) WHERE status = 'DRAFT';
