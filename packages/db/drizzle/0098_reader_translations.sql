CREATE TABLE `bookmarkTranslations` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`version` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`translations` text NOT NULL,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `userTranslationSettings` (
	`userId` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`authTag` text NOT NULL,
	`encryptionVersion` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
