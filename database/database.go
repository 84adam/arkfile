package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	_ "github.com/rqlite/gorqlite/stdlib"
)

var (
	DB *sql.DB
)

func InitDB() {
	var err error

	// Get rqlite connection details from environment
	nodes := os.Getenv("RQLITE_NODES")
	username := os.Getenv("RQLITE_USERNAME")
	password := os.Getenv("RQLITE_PASSWORD")

	if nodes == "" {
		nodes = "localhost:4001"
	}

	if username == "" || password == "" {
		log.Fatal("RQLITE_USERNAME and RQLITE_PASSWORD must be set")
	}

	// Build connection string with authentication
	nodeList := strings.Split(nodes, ",")
	dsn := fmt.Sprintf("http://%s:%s@%s", username, password, nodeList[0])
	if len(nodeList) > 1 {
		dsn += "?disableClusterDiscovery=false"
		for i := 1; i < len(nodeList); i++ {
			dsn += fmt.Sprintf("&node=%s", nodeList[i])
		}
	}

	// Open connection to rqlite cluster
	DB, err = sql.Open("rqlite", dsn)
	if err != nil {
		log.Fatal("Failed to connect to rqlite:", err)
	}

	// Test connection
	if err = DB.Ping(); err != nil {
		log.Fatal("Failed to ping rqlite:", err)
	}

	createTables()
}

func createTables() {
	// Users table
	userTable := `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_storage_bytes BIGINT NOT NULL DEFAULT 0,
        storage_limit_bytes BIGINT NOT NULL DEFAULT 10737418240,
        is_approved BOOLEAN NOT NULL DEFAULT false,
        approved_by TEXT,
        approved_at TIMESTAMP,
        is_admin BOOLEAN NOT NULL DEFAULT false
    );`

	// File metadata table
	fileMetadataTable := `CREATE TABLE IF NOT EXISTS file_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        owner_email TEXT NOT NULL,
        password_hint TEXT,
        password_type TEXT NOT NULL DEFAULT 'custom',
        sha256sum CHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_email) REFERENCES users(email)
    );
    
    -- Create index for faster lookups by hash
    CREATE INDEX IF NOT EXISTS idx_file_metadata_sha256sum ON file_metadata(sha256sum);
    `

	// User activity table
	userActivityTable := `CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_email) REFERENCES users(email)
    );`

	// Access logs table (keep for backwards compatibility)
	accessLogsTable := `CREATE TABLE IF NOT EXISTS access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        action TEXT NOT NULL,
        filename TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_email) REFERENCES users(email)
    );`

	// Admin actions logs table
	adminLogsTable := `CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target_email TEXT NOT NULL,
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_email) REFERENCES users(email),
        FOREIGN KEY (target_email) REFERENCES users(email)
    );`

	tables := []string{userTable, fileMetadataTable, userActivityTable, accessLogsTable, adminLogsTable}

	for _, table := range tables {
		_, err := DB.Exec(table)
		if err != nil {
			log.Fatal(err)
		}
	}

	// Now apply schema extensions after base tables are created
	createExtendedSchema()
}

// createExtendedSchema reads and executes the schema extensions SQL file
func createExtendedSchema() {
	// Check if schema_extensions.sql exists - try multiple locations
	possiblePaths := []string{
		"database/schema_extensions.sql",              // Development/source directory
		"/opt/arkfile/database/schema_extensions.sql", // Production deployment
		"./database/schema_extensions.sql",            // Current working directory
	}

	var extensionsPath string
	for _, path := range possiblePaths {
		if _, err := os.Stat(path); err == nil {
			extensionsPath = path
			break
		}
	}

	if extensionsPath == "" {
		log.Printf("Warning: No schema extensions file found, skipping extended schema creation")
		return
	}

	log.Printf("Loading schema extensions from: %s", extensionsPath)

	// Read the file
	extensionsSQL, err := os.ReadFile(extensionsPath)
	if err != nil {
		log.Printf("Warning: Failed to read schema extensions: %v", err)
		return
	}

	// Split the file into individual statements
	statements := strings.Split(string(extensionsSQL), ";")

	// Execute each statement
	for i, stmt := range statements {
		// Skip empty statements
		trimmed := strings.TrimSpace(stmt)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}

		_, err := DB.Exec(trimmed)
		if err != nil {
			log.Printf("Warning: Failed to execute schema extension statement %d: %v", i+1, err)
			log.Printf("Failing statement: %s", trimmed)
		}
	}

	log.Println("Applied schema extensions for chunked uploads and sharing")
}

// Log user actions
func LogUserAction(email, action, target string) error {
	_, err := DB.Exec(
		"INSERT INTO user_activity (user_email, action, target) VALUES (?, ?, ?)",
		email, action, target,
	)
	return err
}

// Log admin actions
func LogAdminAction(adminEmail, action, targetEmail, details string) error {
	_, err := DB.Exec(
		"INSERT INTO admin_logs (admin_email, action, target_email, details) VALUES (?, ?, ?, ?)",
		adminEmail, action, targetEmail, details,
	)
	return err
}

func LogAdminActionWithTx(tx *sql.Tx, adminEmail, action, targetEmail, details string) error {
	_, err := tx.Exec(
		"INSERT INTO admin_logs (admin_email, action, target_email, details) VALUES (?, ?, ?, ?)",
		adminEmail, action, targetEmail, details,
	)
	return err
}

// ApplyRateLimitingSchema applies the Phase 5E rate limiting database schema
func ApplyRateLimitingSchema() error {
	// Check if rate limiting schema file exists - try multiple locations
	possiblePaths := []string{
		"database/schema_rate_limiting.sql",              // Development/source directory
		"/opt/arkfile/database/schema_rate_limiting.sql", // Production deployment
		"./database/schema_rate_limiting.sql",            // Current working directory
	}

	var schemaPath string
	for _, path := range possiblePaths {
		if _, err := os.Stat(path); err == nil {
			schemaPath = path
			break
		}
	}

	if schemaPath == "" {
		return fmt.Errorf("rate limiting schema file not found")
	}

	log.Printf("Loading rate limiting schema from: %s", schemaPath)

	// Read the schema file
	schemaSQL, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("failed to read rate limiting schema: %w", err)
	}

	// Split the file into individual statements
	statements := strings.Split(string(schemaSQL), ";")

	// Execute each statement
	for _, stmt := range statements {
		// Skip empty statements and comments
		trimmed := strings.TrimSpace(stmt)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}

		_, err := DB.Exec(trimmed)
		if err != nil {
			return fmt.Errorf("failed to execute rate limiting schema statement: %w", err)
		}
	}

	log.Println("Applied Phase 5E rate limiting database schema successfully")
	return nil
}
