// Initialize WebAssembly
let wasmReady = false;

async function initWasm() {
    const go = new Go();
    try {
        const result = await WebAssembly.instantiateStreaming(
            fetch("/main.wasm"),
            go.importObject
        );
        go.run(result.instance);
        wasmReady = true;
    } catch (err) {
        console.error('Failed to load WASM:', err);
    }
}

initWasm();

// Token management functions
async function refreshToken() {
    try {
        // Get the current refresh token from localStorage
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) {
            // If no refresh token, force login
            localStorage.removeItem('token');
            showAuthSection();
            return false;
        }

        const response = await fetch('/api/refresh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('token', data.token);
            localStorage.setItem('refreshToken', data.refreshToken);
            return true;
        } else {
            // Token refresh failed, force login
            localStorage.removeItem('token');
            localStorage.removeItem('refreshToken');
            showAuthSection();
            return false;
        }
    } catch (error) {
        console.error('Token refresh error:', error);
        return false;
    }
}

async function revokeAllSessions() {
    try {
        const response = await fetch('/api/revoke-all', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json',
            }
        });

        if (response.ok) {
            showSuccess('All sessions have been revoked. Please log in again.');
            // Clear local storage and force login
            localStorage.removeItem('token');
            localStorage.removeItem('refreshToken');
            delete window.arkfileSecurityContext;
            showAuthSection();
            return true;
        } else {
            showError('Failed to revoke sessions.');
            return false;
        }
    } catch (error) {
        console.error('Revoke sessions error:', error);
        showError('An error occurred while revoking sessions.');
        return false;
    }
}

// Authentication functions
async function login() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        // First, get the user's salt
        const saltResponse = await fetch('/api/salt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email }),
        });

        if (!saltResponse.ok) {
            showError('Login failed. Please check your credentials.');
            return;
        }

        const saltData = await saltResponse.json();
        const salt = saltData.salt;

        // Hash the password using the salt
        if (!wasmReady) {
            await initWasm(); // Make sure WASM is ready
        }

        const passwordHash = hashPasswordArgon2ID(password, salt);

        // Now attempt login with the hashed password
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, passwordHash }),
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('token', data.token);
            
            // Store refresh token
            if (data.refreshToken) {
                localStorage.setItem('refreshToken', data.refreshToken);
            }
            
            // Generate a random salt for the session key
            const sessionSalt = generateSalt();
            
            // Derive session key using Argon2ID
            const sessionKey = deriveSessionKey(password, sessionSalt);
            
            // Store session key and salt securely in memory
            window.arkfileSecurityContext = {
                sessionKey: sessionKey,
                sessionSalt: sessionSalt,
                // Add expiration timestamp (1 hour)
                expiresAt: Date.now() + (60 * 60 * 1000)
            };
            
            showFileSection();
            loadFiles();
        } else {
            showError('Login failed. Please check your credentials.');
        }
    } catch (error) {
        showError('An error occurred during login.');
    }
}

async function register() {
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;
    const confirmPassword = document.getElementById('register-password-confirm').value;

    if (password !== confirmPassword) {
        showError('Passwords do not match.');
        return;
    }

    // Validate password using common validation function
    const validation = securityUtils.validatePassword(password);
    if (!validation.valid) {
        showError(validation.message);
        return;
    }

    try {
        // Make sure WASM is ready
        if (!wasmReady) {
            await initWasm();
        }

        // Generate salt and hash password client-side
        const salt = generatePasswordSalt();
        const passwordHash = hashPasswordArgon2ID(password, salt);

        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, passwordHash, salt }),
        });

        if (response.ok) {
            toggleAuthForm();
            showSuccess('Registration successful. Please login.');
        } else {
            showError('Registration failed. Please try again.');
        }
    } catch (error) {
        showError('An error occurred during registration.');
    }
}


function updatePasswordStrengthUI(password) {
    const strengthIndicator = document.getElementById('password-strength');
    if (!strengthIndicator) return;

    const requirements = {
        length: password.length >= 12,
        uppercase: /[A-Z]/.test(password),
        lowercase: /[a-z]/.test(password),
        number: /[0-9]/.test(password),
        symbol: /[^A-Za-z0-9]/.test(password)
    };

    let strength = Object.values(requirements).filter(Boolean).length;
    
    const colors = ['#ff4d4d', '#ffaa00', '#ffdd00', '#00cc44', '#00aa44'];
    const labels = ['Very Weak', 'Weak', 'Moderate', 'Strong', 'Very Strong'];

    strengthIndicator.style.width = `${(strength + 1) * 20}%`;
    strengthIndicator.style.backgroundColor = colors[strength];
    strengthIndicator.textContent = labels[strength];
}

// File handling functions
async function uploadFile() {
    if (!wasmReady) {
        showError('WASM not ready. Please try again.');
        return;
    }

    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        showError('Please select a file.');
        return;
    }

    const useCustomPassword = document.getElementById('useCustomPassword').checked;
    let password;
    let keyType;

    if (useCustomPassword) {
        password = document.getElementById('filePassword').value;
        const passwordValidation = securityUtils.validatePassword(password);
        if (!passwordValidation.valid) {
            showError(passwordValidation.message);
            return;
        }
        keyType = 'custom';
    } else {
        // Use the session key
        const securityContext = window.arkfileSecurityContext;
        
        if (!securityContext || Date.now() > securityContext.expiresAt) {
            showError('Your session has expired. Please log in again.');
            localStorage.removeItem('token');
            showAuthSection();
            return;
        }
        
        password = securityContext.sessionKey;
        keyType = 'account';
    }

    const passwordHint = document.getElementById('passwordHint').value;

    try {
        // Read file as ArrayBuffer
        const fileData = await file.arrayBuffer();
        const fileBytes = new Uint8Array(fileData);
        
        // Calculate SHA-256 hash of original file
        const sha256sum = calculateSHA256(fileBytes);
        
        // Encrypt the file
        const encryptedData = encryptFile(fileBytes, password, keyType);

        // Prepare form data
        const formData = new FormData();
        formData.append('filename', file.name);
        formData.append('data', encryptedData);
        formData.append('passwordHint', passwordHint);
        formData.append('passwordType', keyType);
        formData.append('sha256sum', sha256sum);

        // Upload to server
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
            },
            body: formData,
        });

        if (response.ok) {
            showSuccess('File uploaded successfully.');
            loadFiles();
        } else {
            showError('Failed to upload file.');
        }
    } catch (error) {
        console.error('Upload error:', error);
        showError('An error occurred during file upload.');
    }
}

async function downloadFile(filename, hint, expectedHash, passwordType) {
    if (!wasmReady) {
        showError('WASM not ready. Please try again.');
        return;
    }

    if (hint) {
        alert(`Password Hint: ${hint}`);
    }

    let password;
    
    if (passwordType === 'account') {
        // For account-encrypted files, use the session key
        const securityContext = window.arkfileSecurityContext;
        
        if (!securityContext || Date.now() > securityContext.expiresAt) {
            showError('Your session has expired. Please log in again to decrypt account-encrypted files.');
            return;
        }
        
        password = securityContext.sessionKey;
    } else {
        // For custom password-encrypted files
        password = prompt('Enter the file password:');
        if (!password) return;
    }

    try {
        const response = await fetch(`/api/download/${filename}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
            },
        });

        if (response.ok) {
            const data = await response.json();
            const decryptedData = decryptFile(data.data, password);

            if (decryptedData === 'Failed to decrypt data') {
                showError('Incorrect password or corrupted file.');
                return;
            }

            // Convert base64 to Uint8Array for hash verification
            const decryptedBytes = Uint8Array.from(atob(decryptedData), c => c.charCodeAt(0));
            
            // Verify file integrity
            const calculatedHash = calculateSHA256(decryptedBytes);
            if (calculatedHash !== expectedHash) {
                showError('File integrity check failed. The file may be corrupted.');
                return;
            }

            // Create and download the file
            const blob = new Blob([decryptedBytes]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        } else {
            showError('Failed to download file.');
        }
    } catch (error) {
        showError('An error occurred during file download.');
    }
}

async function loadFiles() {
    try {
        const response = await fetch('/api/files', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
            },
        });

        if (response.ok) {
            const data = await response.json();
            const filesList = document.getElementById('filesList');
            filesList.innerHTML = '';

            data.files.forEach(file => {
                const fileElement = document.createElement('div');
                fileElement.className = 'file-item';
                fileElement.innerHTML = `
                    <div class="file-info">
                        <strong>${file.filename}</strong>
                        <span class="file-size">${file.size_readable}</span>
                        <span class="file-date">${new Date(file.uploadDate).toLocaleString()}</span>
                        <span class="encryption-type">${file.passwordType === 'account' ? '🔑 Account Password' : '🔒 Custom Password'}</span>
                    </div>
                    <div class="file-actions">
                        <button onclick="downloadFile('${file.filename}', '${file.passwordHint}', '${file.sha256sum}', '${file.passwordType}')">Download</button>
                    </div>
                `;
                filesList.appendChild(fileElement);
            });

            // Update storage info
            updateStorageInfo(data.storage);
        } else {
            showError('Failed to load files.');
        }
    } catch (error) {
        showError('An error occurred while loading files.');
    }
}

function updateStorageInfo(storage) {
    const storageInfo = document.getElementById('storageInfo');
    if (!storageInfo) return;

    storageInfo.innerHTML = `
        <div class="storage-bar">
            <div class="used" style="width: ${storage.usage_percent}%"></div>
        </div>
        <div class="storage-text">
            Used: ${storage.total_readable} of ${storage.limit_readable} (${storage.usage_percent.toFixed(1)}%)
        </div>
    `;
}

// Logout function
async function logout() {
    try {
        // Get the current refresh token
        const refreshToken = localStorage.getItem('refreshToken');
        
        if (refreshToken) {
            // Call the logout API to revoke the refresh token
            await fetch('/api/logout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ refreshToken }),
            });
        }
        
        // Clear local storage
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        
        // Clear session key from memory
        delete window.arkfileSecurityContext;
        
        // Show auth section
        showAuthSection();
        
        showSuccess('Logged out successfully.');
    } catch (error) {
        console.error('Logout error:', error);
        // Still clear local storage and redirect
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        showAuthSection();
    }
}

// Function to toggle security settings panel
function toggleSecuritySettings() {
    const securityPanel = document.getElementById('security-settings');
    if (securityPanel) {
        securityPanel.classList.toggle('hidden');
    }
}

// UI helper functions
function toggleAuthForm() {
    document.getElementById('login-form').classList.toggle('hidden');
    document.getElementById('register-form').classList.toggle('hidden');
}

function showFileSection() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('file-section').classList.remove('hidden');
}

function showAuthSection() {
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('file-section').classList.add('hidden');
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    setTimeout(() => errorDiv.remove(), 5000);
}

function showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    setTimeout(() => successDiv.remove(), 5000);
}

// Event listeners
window.addEventListener('load', () => {
    if (localStorage.getItem('token')) {
        showFileSection();
        loadFiles();
    }
    
    // Set up password type toggle handling
    const passwordTypeRadios = document.querySelectorAll('input[name="passwordType"]');
    const customPasswordSection = document.getElementById('customPasswordSection');
    const filePassword = document.getElementById('filePassword');
    
    passwordTypeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const useCustomPassword = e.target.value === 'custom';
            customPasswordSection.classList.toggle('hidden', !useCustomPassword);
            if (!useCustomPassword) {
                filePassword.value = ''; // Clear password field when switching to account password
            }
        });
    });

    // Setup password strength monitoring for registration
    const registerPassword = document.getElementById('register-password');
    const registerContainer = document.querySelector('.register-form .password-section');
    registerPassword?.addEventListener('input', (e) => {
        securityUtils.updatePasswordStrengthUI(e.target.value, registerContainer);
    });

    // Setup password strength monitoring for file upload
    filePassword?.addEventListener('input', (e) => {
        securityUtils.updatePasswordStrengthUI(e.target.value, customPasswordSection);
    });
});

// Check session validity periodically
setInterval(() => {
    const securityContext = window.arkfileSecurityContext;
    if (securityContext && Date.now() > securityContext.expiresAt) {
        delete window.arkfileSecurityContext;
    }
}, 60000); // Check every minute
