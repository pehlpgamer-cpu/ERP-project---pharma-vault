-- Supplier purchase returns (WF-15): the two tables, for databases where `npm run db:push` cannot run.
-- Generated from the Drizzle models with `npx drizzle-kit export`; safe to run once.

CREATE TABLE `purchase_returns` (
	`id` char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
	`return_number` varchar(100) NOT NULL,
	`branch_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`supplier_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`status` enum('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`reason` text NOT NULL,
	`created_by` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`approved_by` char(36) CHARACTER SET ascii COLLATE ascii_bin,
	`approved_at` datetime,
	`posted_at` datetime,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `uq_purchase_returns_number` UNIQUE INDEX(`return_number`)
);

CREATE TABLE `purchase_return_items` (
	`id` char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
	`purchase_return_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`inventory_batch_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`quantity` decimal(14,3) NOT NULL,
	`unit_cost` decimal(14,4) NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `chk_purchase_return_items_qty` CHECK(`purchase_return_items`.`quantity` > 0 AND `purchase_return_items`.`unit_cost` >= 0)
);

CREATE INDEX `idx_purchase_return_items_return` ON `purchase_return_items` (`purchase_return_id`);

CREATE INDEX `idx_purchase_returns_branch` ON `purchase_returns` (`branch_id`,`status`);

ALTER TABLE `purchase_return_items` ADD CONSTRAINT `fk_purchase_return_items_return` FOREIGN KEY (`purchase_return_id`) REFERENCES `purchase_returns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `purchase_return_items` ADD CONSTRAINT `fk_purchase_return_items_batch` FOREIGN KEY (`inventory_batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `purchase_returns` ADD CONSTRAINT `fk_purchase_returns_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `purchase_returns` ADD CONSTRAINT `fk_purchase_returns_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `purchase_returns` ADD CONSTRAINT `fk_purchase_returns_creator` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `purchase_returns` ADD CONSTRAINT `fk_purchase_returns_approver` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
