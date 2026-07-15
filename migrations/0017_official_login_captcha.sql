ALTER TABLE official_login_attempts ADD COLUMN captcha_image TEXT;
ALTER TABLE official_login_attempts ADD COLUMN captcha_expires_at INTEGER;
