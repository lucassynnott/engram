#!/usr/bin/env node
/**
 * Engram CLI - Command-line interface for Engram memory management
 */
import { parseMigrateArgs, runEngramMigration } from "./migrate.js";

const command = process.argv[2];

if (!command) {
  console.log(`
Engram CLI - Memory management for OpenClaw

Usage: engram <command> [options]

Commands:
  migrate          Migrate Engram database from v1 to v2

Run 'engram <command> --help' for more information on a command.
`);
  process.exit(0);
}

switch (command) {
  case "migrate": {
    try {
      const options = parseMigrateArgs(process.argv.slice(3));
      const result = runEngramMigration(options);

      if (result.success) {
        console.log("✓ Migration completed successfully");
        if (result.backupPath) {
          console.log(`  Backup: ${result.backupPath}`);
        }
        if (result.tablesCreated.length > 0) {
          console.log(`  Tables created: ${result.tablesCreated.length}`);
        }
        if (result.recordsImported.gigabrainMemories) {
          console.log(`  Gigabrain memories imported: ${result.recordsImported.gigabrainMemories}`);
        }
        if (result.recordsImported.openstingerEpisodes) {
          console.log(`  OpenStinger episodes imported: ${result.recordsImported.openstingerEpisodes}`);
        }
        if (result.recordsImported.openstingerEntities) {
          console.log(`  OpenStinger entities imported: ${result.recordsImported.openstingerEntities}`);
        }
        if (result.warnings.length > 0) {
          console.log("\nWarnings:");
          result.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        }
        process.exit(0);
      } else {
        console.error("✗ Migration failed");
        result.errors.forEach((e) => console.error(`  ✗ ${e}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.log("Run 'engram --help' for available commands.");
    process.exit(1);
}
