/**
 * Registration functionality
 */

import { wasmManager } from '../utils/wasm';
import { showError, showSuccess } from '../ui/messages';
import { showProgressMessage, hideProgress } from '../ui/progress';
import { setTokens } from '../utils/auth';
import { showFileSection } from '../ui/sections';
import { loadFiles } from '../files/list';

export interface RegistrationCredentials {
  email: string;
  password: string;
  confirmPassword: string;
}

export interface RegistrationResponse {
  token: string;
  refreshToken: string;
  sessionKey: string;
  authMethod: 'OPAQUE';
  message: string;
}

export class RegistrationManager {
  public static async register(credentials: RegistrationCredentials): Promise<void> {
    // Validate inputs
    if (!this.validateRegistrationInputs(credentials)) {
      return;
    }

    try {
      // Ensure WASM is ready
      await wasmManager.ensureReady();

      // Check OPAQUE health first
      const healthCheck = await wasmManager.checkOpaqueHealth();
      if (!healthCheck.wasmReady) {
        showError('Registration system not ready. Please try again in a few moments.');
        return;
      }

      showProgressMessage('Creating account...');

      // Validate password complexity using WASM
      const passwordValidation = await wasmManager.validatePasswordComplexity(credentials.password);
      if (!passwordValidation.valid) {
        hideProgress();
        showError(passwordValidation.message);
        this.highlightPasswordRequirements(passwordValidation.requirements, passwordValidation.missing);
        return;
      }

      // Validate password confirmation using WASM
      const confirmationValidation = await wasmManager.validatePasswordConfirmation(
        credentials.password,
        credentials.confirmPassword
      );
      if (!confirmationValidation.match) {
        hideProgress();
        showError(confirmationValidation.message);
        return;
      }

      // Call server OPAQUE registration endpoint
      const response = await fetch('/api/opaque/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password
        }),
      });

      if (response.ok) {
        const data: RegistrationResponse = await response.json();
        await this.completeRegistration(data, credentials.email);
      } else {
        hideProgress();
        const errorData = await response.json().catch(() => ({}));
        showError(errorData.message || 'Registration failed');
      }
    } catch (error) {
      hideProgress();
      console.error('Registration error:', error);
      showError('Registration failed. Please try again.');
    }
  }

  private static validateRegistrationInputs(credentials: RegistrationCredentials): boolean {
    if (!credentials.email || !credentials.password || !credentials.confirmPassword) {
      showError('Please fill in all required fields.');
      return false;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(credentials.email)) {
      showError('Please enter a valid email address.');
      return false;
    }

    return true;
  }

  private static highlightPasswordRequirements(requirements: string[], missing: string[]): void {
    this.updatePasswordRequirementsDisplay({ requirements, missing });
  }

  public static updatePasswordRequirementsDisplay(validation: { requirements: string[], missing: string[] }): void {
    const requirementsList = document.getElementById('password-requirements');
    if (!requirementsList) return;
    
    const items = requirementsList.querySelectorAll('li');
    items.forEach(item => item.classList.remove('met', 'missing'));

    validation.requirements.forEach(req => {
      const item = Array.from(items).find(li => li.textContent?.includes(req));
      if (item) {
        item.classList.add(validation.missing.includes(req) ? 'missing' : 'met');
      }
    });
  }

  private static async completeRegistration(data: RegistrationResponse, email: string): Promise<void> {
    try {
      // Store authentication tokens
      setTokens(data.token, data.refreshToken);
      
      // Create secure session in WASM (NEVER store session key in JavaScript)
      const sessionResult = await wasmManager.createSecureSession(data.sessionKey, email);
      if (!sessionResult.success) {
        hideProgress();
        showError('Failed to create secure session: ' + sessionResult.error);
        return;
      }
      
      hideProgress();
      showSuccess('Registration successful! Welcome to ArkFile.');
      
      // Navigate to file section and load files
      showFileSection();
      await loadFiles();
      
    } catch (error) {
      hideProgress();
      console.error('Registration completion error:', error);
      showError('Failed to complete registration');
    }
  }
}

// Form handling utilities
export function setupRegistrationForm(): void {
  const registerForm = document.getElementById('register-form');
  if (!registerForm) return;

  const emailInput = document.getElementById('register-email') as HTMLInputElement;
  const passwordInput = document.getElementById('register-password') as HTMLInputElement;
  const confirmPasswordInput = document.getElementById('register-confirm-password') as HTMLInputElement;
  const submitButton = registerForm.querySelector('button[type="submit"]') as HTMLButtonElement;

  if (!emailInput || !passwordInput || !confirmPasswordInput || !submitButton) return;

  // Handle form submission
  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    
    const credentials: RegistrationCredentials = {
      email: emailInput.value.trim(),
      password: passwordInput.value,
      confirmPassword: confirmPasswordInput.value
    };

    await RegistrationManager.register(credentials);
  };

  // Add event listeners
  registerForm.addEventListener('submit', handleSubmit);
  
  // Handle Enter key in form fields
  [emailInput, passwordInput, confirmPasswordInput].forEach(input => {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleSubmit(e);
      }
    });
  });

  // Clear any previous error states when user starts typing
  [emailInput, passwordInput, confirmPasswordInput].forEach(input => {
    input.addEventListener('input', () => {
      input.classList.remove('error');
    });
  });

  // Real-time password validation
  passwordInput.addEventListener('input', async () => {
    if (passwordInput.value.length > 0) {
      await validatePasswordRealTime(passwordInput.value);
    }
  });

  // Real-time password confirmation validation
  confirmPasswordInput.addEventListener('input', async () => {
    if (confirmPasswordInput.value.length > 0 && passwordInput.value.length > 0) {
      await validatePasswordConfirmationRealTime(passwordInput.value, confirmPasswordInput.value);
    }
  });
}

// Real-time validation functions
async function validatePasswordRealTime(password: string): Promise<void> {
  try {
    await wasmManager.ensureReady();
    const validation = await wasmManager.validatePasswordComplexity(password);
    
    const passwordInput = document.getElementById('register-password') as HTMLInputElement;
    const requirementsList = document.getElementById('password-requirements');
    
    if (validation.valid) {
      passwordInput.classList.remove('error');
      passwordInput.classList.add('valid');
    } else {
      passwordInput.classList.remove('valid');
      passwordInput.classList.add('error');
    }

    // Update requirements display using the consolidated helper
    RegistrationManager.updatePasswordRequirementsDisplay(validation);
  } catch (error) {
    console.warn('Real-time password validation error:', error);
  }
}

async function validatePasswordConfirmationRealTime(password: string, confirmation: string): Promise<void> {
  try {
    await wasmManager.ensureReady();
    const validation = await wasmManager.validatePasswordConfirmation(password, confirmation);
    
    const confirmInput = document.getElementById('register-confirm-password') as HTMLInputElement;
    
    if (validation.match) {
      confirmInput.classList.remove('error');
      confirmInput.classList.add('valid');
    } else {
      confirmInput.classList.remove('valid');
      confirmInput.classList.add('error');
    }
  } catch (error) {
    console.warn('Real-time password confirmation validation error:', error);
  }
}

// Export utility functions for compatibility
export async function register(): Promise<void> {
  const emailInput = document.getElementById('register-email') as HTMLInputElement;
  const passwordInput = document.getElementById('register-password') as HTMLInputElement;
  const confirmPasswordInput = document.getElementById('register-confirm-password') as HTMLInputElement;
  
  if (!emailInput || !passwordInput || !confirmPasswordInput) {
    showError('Registration form not found.');
    return;
  }

  const credentials: RegistrationCredentials = {
    email: emailInput.value.trim(),
    password: passwordInput.value,
    confirmPassword: confirmPasswordInput.value
  };

  await RegistrationManager.register(credentials);
}
