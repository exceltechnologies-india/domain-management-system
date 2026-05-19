'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import Button from './Button';
import Card from './Card';
import Logo from './Logo';
import SocialLoginButtons from './SocialLoginButtons';
import toast from 'react-hot-toast';
import { safeLocalStorage } from '@/lib/storage';
import GoogleRecaptcha from './GoogleRecaptcha';
import PersonalInfoSection from './register/PersonalInfoSection';
import AddressSection from './register/AddressSection';
import CredentialsSection from './register/CredentialsSection';
import type { RegisterFormData } from './register/types';

interface RegisterFormProps {
  className?: string;
}

const EMPTY_FORM: RegisterFormData = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  confirmPassword: '',
  phone: '',
  phoneCc: '+91',
  companyName: '',
  address: {
    line1: '',
    city: '',
    state: '',
    country: 'IN',
    zipcode: '',
  },
};

export default function RegisterForm({ className = '' }: RegisterFormProps) {
  const [formData, setFormData] = useState<RegisterFormData>(EMPTY_FORM);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const router = useRouter();

  const totalSteps = 4;

  // Step validation functions
  const validateStep = (step: number): boolean => {
    switch (step) {
      case 1: // Personal Info
        return !!(formData.firstName && formData.lastName && formData.email && formData.companyName);
      case 2: // Contact Info
        return !!(formData.phone && formData.phoneCc);
      case 3: // Address Info
        return !!(formData.address.line1 && formData.address.city && formData.address.state && formData.address.zipcode);
      case 4: // Password
        return !!(formData.password && formData.confirmPassword && formData.password === formData.confirmPassword);
      default:
        return false;
    }
  };

  const nextStep = () => {
    if (validateStep(currentStep)) {
      if (!completedSteps.includes(currentStep)) {
        setCompletedSteps([...completedSteps, currentStep]);
      }
      if (currentStep < totalSteps) {
        setCurrentStep(currentStep + 1);
      }
    } else {
      toast.error('Please fill in all required fields before proceeding');
    }
  };

  // Load form data from localStorage on component mount (excluding passwords)
  useEffect(() => {
    const savedData = safeLocalStorage.getItem('registerFormData');
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setFormData(prev => ({
          ...prev,
          firstName: parsedData.firstName || '',
          lastName: parsedData.lastName || '',
          email: parsedData.email || '',
          phone: parsedData.phone || '',
          address: parsedData.address || {
            line1: '',
            city: '',
            state: '',
            country: 'IN',
            zipcode: '',
          },
          // Don't restore passwords for security
          password: '',
          confirmPassword: '',
        }));
      } catch (_error) {
        // Silent error handling
      }
    }
  }, []);

  // Save form data to localStorage whenever it changes (excluding passwords)
  useEffect(() => {
    const dataToSave = {
      firstName: formData.firstName,
      lastName: formData.lastName,
      email: formData.email,
      phone: formData.phone,
      phoneCc: formData.phoneCc,
      companyName: formData.companyName,
      address: formData.address,
      // Don't save passwords for security
    };
    safeLocalStorage.setItem('registerFormData', JSON.stringify(dataToSave));
  }, [formData.firstName, formData.lastName, formData.email, formData.phone, formData.phoneCc, formData.companyName, formData.address]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // If not on final step, go to next step
    if (currentStep < totalSteps) {
      nextStep();
      return;
    }

    // Final step - submit the form
    setIsLoading(true);

    // Validate passwords match
    if (formData.password !== formData.confirmPassword) {
      toast.error('Passwords do not match');
      setIsLoading(false);
      return;
    }

    try {
      // Check if reCAPTCHA is configured
      const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
      const isRecaptchaConfigured = recaptchaSiteKey && recaptchaSiteKey !== 'your-recaptcha-site-key';

      // Only require reCAPTCHA token if reCAPTCHA is configured
      if (isRecaptchaConfigured && !recaptchaToken) {
        toast.error('Please complete the security verification');
        setIsLoading(false);
        return;
      }

      const response = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstName: formData.firstName,
          lastName: formData.lastName,
          email: formData.email,
          password: formData.password,
          phone: formData.phone,
          phoneCc: formData.phoneCc,
          companyName: formData.companyName,
          address: formData.address,
          recaptchaToken: recaptchaToken,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        // Store token in localStorage
        safeLocalStorage.setItem('token', data.token);
        safeLocalStorage.setItem('user', JSON.stringify(data.user));

        // Store token in cookie for server-side access.
        // HttpOnly cannot be set here (client-side write); JS reads this cookie for
        // Authorization headers. SameSite=Lax blocks cross-site form submissions;
        // Secure ensures the cookie is only sent over HTTPS in production.
        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `token=${data.token}; path=/; max-age=${24 * 60 * 60}; SameSite=Lax${secure}`;

        // Clear saved form data on successful registration
        safeLocalStorage.removeItem('registerFormData');

        toast.success('Registration successful!');

        // Small delay to ensure cookie is set
        setTimeout(() => {
          router.push('/dashboard');
        }, 100);
      } else {
        toast.error(data.error || 'Registration failed');
      }
    } catch (_error) {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    if (name.startsWith('address.')) {
      const addressField = name.split('.')[1];
      setFormData({
        ...formData,
        address: {
          ...formData.address,
          [addressField]: value,
        },
      });
    } else {
      setFormData({
        ...formData,
        [name]: value,
      });
    }
  };

  const detectLocation = async () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by this browser');
      return;
    }

    // Check if we're on a secure context (HTTPS or localhost)
    if (!window.isSecureContext) {
      toast.error('Location detection requires HTTPS. Please fill the address manually or use a secure connection.');
      return;
    }

    setIsDetectingLocation(true);

    try {
      // Get current position
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000 // 5 minutes
        });
      });

      const { latitude, longitude } = position.coords;

      // Use reverse geocoding to get address details
      // Try multiple geocoding services for better reliability
      interface GeocodeAdminEntry {
        name?: string;
        description?: string;
        adminLevel?: number;
      }
      interface GeocodeInformativeEntry {
        name?: string;
        description?: string;
      }
      interface GeocodeData {
        city?: string;
        locality?: string;
        principalSubdivision?: string;
        administrativeAreaLevel1?: string;
        countryCode?: string;
        postcode?: string;
        localityInfo?: {
          administrative?: GeocodeAdminEntry[];
          informative?: GeocodeInformativeEntry[];
        };
      }
      let data: GeocodeData;
      try {
        // Primary service: BigDataCloud (free, no API key required)
        const response = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
          {
            headers: {
              'Accept-Language': 'en'
            }
          }
        );

        if (!response.ok) {
          throw new Error('Primary geocoding service failed');
        }

        data = await response.json();
      } catch (_primaryError) {
        // Try fallback service

        // Fallback service: OpenStreetMap Nominatim (free, no API key required)
        const fallbackResponse = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=en`,
          {
            headers: {
              'Accept-Language': 'en',
              'User-Agent': 'Anutech Digital Private Limited Domain Management'
            }
          }
        );

        if (!fallbackResponse.ok) {
          throw new Error('All geocoding services failed');
        }

        const fallbackData = await fallbackResponse.json();

        // Convert Nominatim format to our expected format
        data = {
          city: fallbackData.address?.city || fallbackData.address?.town || fallbackData.address?.village,
          locality: fallbackData.address?.city || fallbackData.address?.town || fallbackData.address?.village,
          principalSubdivision: fallbackData.address?.state,
          administrativeAreaLevel1: fallbackData.address?.state,
          countryCode: fallbackData.address?.country_code?.toUpperCase(),
          postcode: fallbackData.address?.postcode,
          localityInfo: {
            administrative: [{
              name: fallbackData.address?.city || fallbackData.address?.town || fallbackData.address?.village
            }]
          }
        };
      }

      // Extract a better Address Line 1
      // BigDataCloud administrative array is sorted most-significant-first (Country -> State -> District -> City -> Neighborhood)
      const adminList = data.localityInfo?.administrative || [];
      const countryIndex = adminList.findIndex((item) => item.adminLevel === 2 || item.description?.toLowerCase().includes('country') || item.name?.toLowerCase() === 'india');
      const stateIndex = adminList.findIndex((item) => item.adminLevel === 4 || item.description?.toLowerCase().includes('state') || item.name?.toLowerCase().includes('delhi'));

      // Filter out country and state from line1 candidates if possible
      const moreSpecificEntries = adminList.filter((_, index) => index > Math.max(countryIndex, stateIndex));

      let line1 = '';
      if (moreSpecificEntries.length > 0) {
        // Use the most specific locality for line1
        line1 = moreSpecificEntries[moreSpecificEntries.length - 1].name ?? '';
      } else {
        // Fallback to locality or whatever is after country if it exists
        line1 = data.locality || (adminList.length > 1 ? (adminList[adminList.length - 1].name ?? '') : data.principalSubdivision || '');
      }

      // Try to find postcode in informative array if missing at top level
      let zipcode = data.postcode || '';
      if (!zipcode && data.localityInfo?.informative) {
        const postcodeEntry = data.localityInfo.informative.find((item) => item.name?.match(/^\d{6}$/) || item.description?.toLowerCase().includes('postcode') || item.description?.toLowerCase().includes('zip'));
        if (postcodeEntry?.name) {
          zipcode = postcodeEntry.name;
        }
      }

      // If ZipCode is STILL missing, try a targeted fallback to Nominatim
      if (!zipcode) {
        try {
          const fallbackResponse = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=en`,
            {
              headers: {
                'Accept-Language': 'en',
                'User-Agent': 'Anutech Digital Private Limited Domain Management'
              }
            }
          );
          if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            zipcode = fallbackData.address?.postcode || '';
          }
        } catch (_e) {
          // Silent fallback failure
        }
      }

      // Update form with detected location (India only)
      setFormData(prev => ({
        ...prev,
        address: {
          line1: line1,
          city: data.city || data.locality || '',
          state: data.principalSubdivision || data.administrativeAreaLevel1 || '',
          country: 'IN', // Always set to India
          zipcode: zipcode,
        }
      }));

      toast.success('Location detected and address filled automatically!');
    } catch (error: unknown) {
      // Location detection failed. GeolocationPositionError uses numeric `code`
      // (1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT). Other errors
      // (fetch failures, etc.) won't have `code` set — handled by the else.
      const geoErr = error as { code?: number; message?: string };
      if (geoErr.code === 1) {
        if (geoErr.message?.includes('secure origins')) {
          toast.error('Location detection requires HTTPS. Please use a secure connection or fill the address manually.');
        } else {
          toast.error('Location access denied. Please enable location permissions.');
        }
      } else if (geoErr.code === 2) {
        toast.error('Location unavailable. Please check your internet connection.');
      } else if (geoErr.code === 3) {
        toast.error('Location request timed out. Please try again.');
      } else {
        toast.error('Failed to detect location. Please fill the address manually.');
      }
    } finally {
      setIsDetectingLocation(false);
    }
  };

  return (
    <div className={`min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 ${className}`} style={{
      backgroundImage: `
        linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px)
      `,
      backgroundSize: '40px 40px',
      backgroundPosition: '0 0, 0 0'
    }}>
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <Logo size="lg" showText={false} />
          </div>
          <h2 className="text-3xl font-bold text-gray-900">
            Create your account
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Or{' '}
            <a href="/login" className="font-medium text-primary-600 hover:text-primary-500">
              sign in to your existing account
            </a>
          </p>
        </div>

        <Card>
          <div
            className="space-y-6"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          >
            <PersonalInfoSection formData={formData} onChange={handleChange} />

            <AddressSection
              formData={formData}
              onChange={handleChange}
              isDetectingLocation={isDetectingLocation}
              onDetectLocation={detectLocation}
            />

            <CredentialsSection formData={formData} onChange={handleChange} />

            {currentStep === totalSteps &&
              process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY &&
              process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' && (
                <GoogleRecaptcha
                  onSuccess={(token) => setRecaptchaToken(token)}
                  onError={() => setRecaptchaToken(null)}
                  onExpire={() => setRecaptchaToken(null)}
                  className="flex justify-center"
                />
              )}

            <Button
              type="button"
              onClick={handleSubmit}
              loading={isLoading}
              fullWidth
              icon={<UserPlus className="h-4 w-4" />}
              disabled={(currentStep === totalSteps &&
                 !!(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY &&
                   process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY !== 'your-recaptcha-site-key' &&
                   !recaptchaToken)) || (formData.password.length > 0 && formData.password.length < 8)}
            >
              {isLoading ? 'Creating account...' : 'Create account'}
            </Button>

            <SocialLoginButtons
              onSuccess={() => {
                // Redirect to dashboard after successful social login
                setTimeout(() => {
                  router.push('/dashboard');
                }, 100);
              }}
              onError={(_error) => {
                // Social login error handled
              }}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
