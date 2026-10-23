-- migrations/0030_media_per_uploader.sql — every upload is its sender's own record (TASK-058 review, D212).
--
-- 0026 kept one row per picture (sha256 unique): a second person sending the same bytes was answered
-- with the FIRST person's record — one they may not be allowed to see, with that person's retention, and
-- no record or audit row of their own. Now each person's upload is their own row; the cleaned bytes are
-- still stored once (content-addressed), and they are deleted only when no row needs them any more.

alter table media_object drop constraint if exists media_object_sha256_key;
alter table media_object drop constraint if exists media_object_storage_path_key;
alter table media_object drop constraint if exists media_object_thumb_path_key;

-- One record per person per picture (a person sending the same picture again gets their record back).
create unique index if not exists uq_media_object_uploader_sha on media_object (uploaded_by, sha256);
-- Finding the stored bytes of a picture someone else already sent, and who still needs a file.
create index if not exists idx_media_object_sha256 on media_object (sha256);
create index if not exists idx_media_object_storage_path on media_object (storage_path);
