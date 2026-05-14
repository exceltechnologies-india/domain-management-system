export interface HostingPlanConfig {
  id: string;
  name: string; // Display Name
  price: number;
  currency: string;
  period: string; // e.g. "/mo"
  features: string[]; // List of feature strings for frontend display
  description: string; // Short subtitle/description
  
  // Backend Mapping
  serverPackage: string; // MUST match DirectAdmin package name exactly (Survivor 2)
  
  // Resource Reference (for display matching)
  quotaMB: number;
  bandwidthMB: number;
  
  isPopular?: boolean;
  highlightFeatures?: string[]; // Features to highlight (bold)
}

export const HOSTING_PLANS: Record<string, HostingPlanConfig> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'Small business solution',
    price: 49.99,
    currency: 'INR',
    period: '/mo',
    serverPackage: 'Starter', // Matches DA Screenshot
    quotaMB: 10000, // 10 GB
    bandwidthMB: 100000, // 100 GB
    features: [
      "10 GB SSD storage",
      "Unlimited Free SSL",
      "100GB Bandwidth",
      "Host 1 Website",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host 1 Website"]
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    description: 'Growing business sites',
    price: 125.00,
    currency: 'INR',
    period: '/mo',
    isPopular: true,
    serverPackage: 'Standard', // Matches DA
    quotaMB: 25000, // 25 GB
    bandwidthMB: 200000, // 200 GB
    features: [
      "25 GB SSD storage",
      "Unlimited Free SSL",
      "200GB Bandwidth",
      "Host Multiple Websites",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"]
  },
  plus: {
    id: 'plus',
    name: 'Plus',
    description: 'High scale sites',
    price: 187.20,
    currency: 'INR',
    period: '/mo',
    serverPackage: 'Plus', // Matches DA
    quotaMB: 50000, // 50 GB
    bandwidthMB: -1, // Unmetered
    features: [
      "50 GB SSD storage",
      "Unlimited Free SSL",
      "Unmetered Bandwidth",
      "Host Multiple Websites",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Priority Support",
      "Advanced Security Features",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"]
  }
};

export const CUSTOM_PLAN_FEATURES = [
  { text: "Unlimited Websites", included: true, highlight: true },
  { text: "Custom NVMe Storage", included: true },
  { text: "Priority Support", included: true },
  { text: "Custom Resources", included: true },
  { text: "Dedicated IP", included: true },
  { text: "VPS & Custom Panel Requests Accepted", included: true },
];
