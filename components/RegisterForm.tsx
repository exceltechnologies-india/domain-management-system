'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, Mail, User, UserPlus, Phone, MapPin, MapPinIcon, Loader2 } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import Card from './Card';
import Logo from './Logo';
import SocialLoginButtons from './SocialLoginButtons';
import toast from 'react-hot-toast';
import { showSuccessToast, showErrorToast, showAccountDeactivated } from '@/lib/toast';
import { safeLocalStorage } from '@/lib/storage';
import GoogleRecaptcha from './GoogleRecaptcha';
import { INDIAN_STATES } from '@/lib/constants';

interface RegisterFormProps {
  className?: string;
}

export default function RegisterForm({ className = '' }: RegisterFormProps) {
  const [formData, setFormData] = useState({
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
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
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

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const goToStep = (step: number) => {
    if (step <= currentStep || completedSteps.includes(step - 1)) {
      setCurrentStep(step);
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
      } catch (error) {
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

      const response = await fetch('/api/auth/register', {
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
    } catch (error) {
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
      let data: any;
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
      } catch (primaryError) {
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
      const countryIndex = adminList.findIndex((item: any) => item.adminLevel === 2 || item.description?.toLowerCase().includes('country') || item.name?.toLowerCase() === 'india');
      const stateIndex = adminList.findIndex((item: any) => item.adminLevel === 4 || item.description?.toLowerCase().includes('state') || item.name?.toLowerCase().includes('delhi'));
      
      // Filter out country and state from line1 candidates if possible
      const moreSpecificEntries = adminList.filter((_: any, index: number) => index > Math.max(countryIndex, stateIndex));
      
      let line1 = '';
      if (moreSpecificEntries.length > 0) {
        // Use the most specific locality for line1
        line1 = moreSpecificEntries[moreSpecificEntries.length - 1].name;
      } else {
        // Fallback to locality or whatever is after country if it exists
        line1 = data.locality || (adminList.length > 1 ? adminList[adminList.length - 1].name : data.principalSubdivision || '');
      }

      // Try to find postcode in informative array if missing at top level
      let zipcode = data.postcode || '';
      if (!zipcode && data.localityInfo?.informative) {
        const postcodeEntry = data.localityInfo.informative.find((item: any) => item.name?.match(/^\d{6}$/) || item.description?.toLowerCase().includes('postcode') || item.description?.toLowerCase().includes('zip'));
        if (postcodeEntry) {
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
        } catch (e) {
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
    } catch (error: any) {
      // Location detection failed

      if (error.code === 1) {
        if (error.message.includes('secure origins')) {
          toast.error('Location detection requires HTTPS. Please use a secure connection or fill the address manually.');
        } else {
          toast.error('Location access denied. Please enable location permissions.');
        }
      } else if (error.code === 2) {
        toast.error('Location unavailable. Please check your internet connection.');
      } else if (error.code === 3) {
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
                handleSubmit(e as any);
              }
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="First name"
                name="firstName"
                placeholder="Enter your first name"
                value={formData.firstName}
                onChange={handleChange}
                required
                fullWidth
                icon={<User className="h-4 w-4 text-gray-400" />}
              />
              <Input
                label="Last name"
                name="lastName"
                placeholder="Enter your last name"
                value={formData.lastName}
                onChange={handleChange}
                required
                fullWidth
                icon={<User className="h-4 w-4 text-gray-400" />}
              />
            </div>

            <Input
              label="Email address"
              name="email"
              type="email"
              placeholder="Enter your email address"
              value={formData.email}
              onChange={handleChange}
              required
              fullWidth
              icon={<Mail className="h-4 w-4 text-gray-400" />}
            />

            <Input
              label="Company name"
              name="companyName"
              placeholder="Enter your company name"
              value={formData.companyName}
              onChange={handleChange}
              required
              fullWidth
              icon={<User className="h-4 w-4 text-gray-400" />}
            />

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Country Code
                </label>
                <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
                  🇮🇳 +91 (India)
                </div>
                <input type="hidden" name="phoneCc" value="+91" />
              </div>
              <div className="col-span-2">
                <Input
                  label="Phone number"
                  name="phone"
                  type="tel"
                  placeholder="Enter your phone number"
                  value={formData.phone}
                  onChange={handleChange}
                  required
                  fullWidth
                  icon={<Phone className="h-4 w-4 text-gray-400" />}
                  helperText="Enter phone number without country code"
                />
              </div>
            </div>


            {/* Address Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900 flex items-center">
                  <MapPin className="h-5 w-5 text-gray-400 mr-2" />
                  Address Information
                </h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={detectLocation}
                  disabled={isDetectingLocation}
                  loading={isDetectingLocation}
                  icon={!isDetectingLocation && <MapPinIcon className="h-4 w-4" />}
                  className="text-blue-600"
                >
                  Auto-fill
                </Button>
              </div>

              <Input
                label="Address Line 1"
                name="address.line1"
                placeholder="Street address, P.O. box"
                value={formData.address.line1}
                onChange={handleChange}
                required
                fullWidth
                icon={<MapPin className="h-4 w-4 text-gray-400" />}
              />

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="City"
                  name="address.city"
                  placeholder="Enter city"
                  value={formData.address.city}
                  onChange={handleChange}
                  required
                  fullWidth
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    State/Province
                  </label>
                  <select
                    name="address.state"
                    value={formData.address.state}
                    onChange={handleChange}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white"
                  >
                    <option value="" disabled>Select state</option>
                    {INDIAN_STATES.map(state => (
                      <option key={state} value={state}>{state}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Country
                  </label>
                  <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
                    🇮🇳 India
                  </div>
                  <input type="hidden" name="address.country" value="IN" />
                </div>
                <Input
                  label="ZIP/Postal Code"
                  name="address.zipcode"
                  placeholder="Enter ZIP code"
                  value={formData.address.zipcode}
                  onChange={handleChange}
                  required
                  fullWidth
                />
              </div>
            </div>

            <div className="relative">
              <Input
                label="Password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Create a strong password"
                value={formData.password}
                onChange={handleChange}
                required
                fullWidth
                icon={<Lock className="h-4 w-4 text-gray-400" />}
                helperText="Min. 8 characters with uppercase, lowercase, number, and special character"
                rightIcon={
                  <button
                    type="button"
                    className="text-gray-500 hover:text-gray-700 focus:outline-none"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
            </div>

            <div className="relative">
              <Input
                label="Confirm password"
                name="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="Confirm your password"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                fullWidth
                icon={<Lock className="h-4 w-4 text-gray-400" />}
                rightIcon={
                  <button
                    type="button"
                    className="text-gray-500 hover:text-gray-700 focus:outline-none"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                }
              />
            </div>

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
              onError={(error) => {
                // Social login error handled
              }}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
