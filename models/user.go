package models

import (
	"database/sql"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/84adam/arkfile/auth"
)

type User struct {
	ID                int64          `json:"id"`
	Email             string         `json:"email"`
	PasswordHash      string         `json:"-"` // Never send password hash in JSON
	PasswordSalt      string         `json:"-"` // Never send password salt in JSON
	CreatedAt         time.Time      `json:"created_at"`
	TotalStorageBytes int64          `json:"total_storage_bytes"`
	StorageLimitBytes int64          `json:"storage_limit_bytes"`
	IsApproved        bool           `json:"is_approved"`
	ApprovedBy        sql.NullString `json:"approved_by,omitempty"`
	ApprovedAt        sql.NullTime   `json:"approved_at,omitempty"`
	IsAdmin           bool           `json:"is_admin"`
}

const (
	DefaultStorageLimit int64 = 10737418240 // 10GB in bytes
)

// CreateUser creates a new user in the database
func CreateUser(db *sql.DB, email, password string) (*User, error) {
	// Use Argon2ID for password hashing
	hashedPassword, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}

	isAdmin := isAdminEmail(email)
	result, err := db.Exec(
		`INSERT INTO users (
			email, password_hash, storage_limit_bytes, is_admin, is_approved
		) VALUES (?, ?, ?, ?, ?)`,
		email, hashedPassword, DefaultStorageLimit,
		isAdmin, isAdmin, // Auto-approve admin emails
	)
	if err != nil {
		return nil, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}

	return &User{
		ID:                id,
		Email:             email,
		StorageLimitBytes: DefaultStorageLimit,
		CreatedAt:         time.Now(),
		IsApproved:        isAdmin,
		IsAdmin:           isAdmin,
	}, nil
}

// CreateUserWithHash creates a new user with pre-hashed password and salt
func CreateUserWithHash(db *sql.DB, email, passwordHash, salt string) (*User, error) {
	isAdmin := isAdminEmail(email)
	result, err := db.Exec(
		`INSERT INTO users (
			email, password_hash, password_salt, storage_limit_bytes, is_admin, is_approved
		) VALUES (?, ?, ?, ?, ?, ?)`,
		email, passwordHash, salt, DefaultStorageLimit,
		isAdmin, isAdmin, // Auto-approve admin emails
	)
	if err != nil {
		return nil, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}

	return &User{
		ID:                id,
		Email:             email,
		PasswordSalt:      salt,
		StorageLimitBytes: DefaultStorageLimit,
		CreatedAt:         time.Now(),
		IsApproved:        isAdmin,
		IsAdmin:           isAdmin,
	}, nil
}

// GetUserByEmail retrieves a user by email
func GetUserByEmail(db *sql.DB, email string) (*User, error) {
	user := &User{}
	var salt sql.NullString
	err := db.QueryRow(`
		SELECT id, email, password_hash, password_salt, created_at,
		       total_storage_bytes, storage_limit_bytes,
		       is_approved, approved_by, approved_at, is_admin
		FROM users WHERE email = ?`,
		email,
	).Scan(
		&user.ID, &user.Email, &user.PasswordHash, &salt, &user.CreatedAt,
		&user.TotalStorageBytes, &user.StorageLimitBytes,
		&user.IsApproved, &user.ApprovedBy, &user.ApprovedAt, &user.IsAdmin, // Scan directly into sql.Null* types
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, err // Return sql.ErrNoRows directly
		}
		return nil, err
	}

	// Convert nullable salt to string
	if salt.Valid {
		user.PasswordSalt = salt.String
	}

	return user, nil
}

// VerifyPassword checks if the provided password matches the stored hash
func (u *User) VerifyPassword(password string) bool {
	return auth.VerifyPassword(password, u.PasswordHash)
}

// VerifyPasswordHash compares a client-provided hash with stored hash
func (u *User) VerifyPasswordHash(providedHash string) bool {
	return providedHash == u.PasswordHash
}

// UpdatePassword updates the user's password
func (u *User) UpdatePassword(db *sql.DB, newPassword string) error {
	// Use Argon2ID for password hashing
	hashedPassword, err := auth.HashPassword(newPassword)
	if err != nil {
		return err
	}

	_, err = db.Exec(
		"UPDATE users SET password_hash = ? WHERE id = ?",
		hashedPassword, u.ID,
	)
	return err
}

// HasAdminPrivileges checks if a user has admin privileges
func (u *User) HasAdminPrivileges() bool {
	return u.IsAdmin || isAdminEmail(u.Email)
}

// ApproveUser approves a user (admin only)
func (u *User) ApproveUser(db *sql.DB, adminEmail string) error {
	if !isAdminEmail(adminEmail) {
		return errors.New("unauthorized: admin privileges required")
	}

	now := time.Now()
	_, err := db.Exec(`
		UPDATE users 
		SET is_approved = true, 
		approved_by = ?,
		    approved_at = ?
		WHERE id = ?`,
		adminEmail, now, u.ID,
	)
	if err != nil {
		return err
	}

	// Update struct fields using sql.Null* types
	u.IsApproved = true
	u.ApprovedBy = sql.NullString{String: adminEmail, Valid: true}
	u.ApprovedAt = sql.NullTime{Time: now, Valid: true}

	return nil
}

// CheckStorageAvailable checks if a file of the given size can be stored
func (u *User) CheckStorageAvailable(size int64) bool {
	return (u.TotalStorageBytes + size) <= u.StorageLimitBytes
}

// UpdateStorageUsage updates the user's total storage (should be called in a transaction)
func (u *User) UpdateStorageUsage(tx *sql.Tx, deltaBytes int64) error {
	// deltaBytes can be positive (for additions) or negative (for deletions)
	newTotal := u.TotalStorageBytes + deltaBytes
	if newTotal < 0 {
		newTotal = 0
	}

	_, err := tx.Exec(
		"UPDATE users SET total_storage_bytes = ? WHERE id = ?",
		newTotal, u.ID,
	)
	if err != nil {
		return err
	}

	u.TotalStorageBytes = newTotal
	return nil
}

// GetStorageUsagePercent returns the user's storage usage as a percentage
func (u *User) GetStorageUsagePercent() float64 {
	if u.StorageLimitBytes == 0 {
		return 0.0
	}
	return (float64(u.TotalStorageBytes) / float64(u.StorageLimitBytes)) * 100
}

// GetPendingUsers retrieves users pending approval (admin only)
func GetPendingUsers(db *sql.DB) ([]*User, error) {
	rows, err := db.Query(`
		SELECT id, email, created_at, total_storage_bytes, storage_limit_bytes
		FROM users
		WHERE is_approved = false
		ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		user := &User{}
		err := rows.Scan(
			&user.ID, &user.Email, &user.CreatedAt,
			&user.TotalStorageBytes, &user.StorageLimitBytes,
		)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}

	return users, rows.Err()
}

// isAdminEmail checks if an email is in the admin list
func isAdminEmail(email string) bool {
	adminEmails := strings.Split(getEnvOrDefault("ADMIN_EMAILS", ""), ",")
	for _, adminEmail := range adminEmails {
		if strings.TrimSpace(adminEmail) == email {
			return true
		}
	}
	return false
}

// Helper function to get environment variable with default
func getEnvOrDefault(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}
