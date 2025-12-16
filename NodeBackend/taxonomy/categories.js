// NodeBackend/taxonomy/categories.js
// Canonical taxonomy – single source of truth

const TAXONOMY = {
  electronics: {
    label: "Electronics",
    subcategories: {
      audio: "Audio",
      mobile_accessories: "Mobile Accessories",
      computers: "Computers",
      computer_accessories: "Computer Accessories",
      smart_devices: "Smart Devices",
      cameras: "Cameras",
      wearables: "Wearables",
      networking: "Networking",
      gaming_electronics: "Gaming Electronics",
    },
  },

  home_living: {
    label: "Home & Living",
    subcategories: {
      kitchen: "Kitchen",
      home_appliances: "Home Appliances",
      furniture: "Furniture",
      home_decor: "Home Decor",
      lighting: "Lighting",
      cleaning: "Cleaning",
      storage_organisation: "Storage & Organisation",
      bedding_bath: "Bedding & Bath",
    },
  },

  fashion: {
    label: "Fashion",
    subcategories: {
      clothing: "Clothing",
      footwear: "Footwear",
      bags_wallets: "Bags & Wallets",
      watches: "Watches",
      sunglasses: "Sunglasses",
      jewellery: "Jewellery",
      fashion_accessories: "Fashion Accessories",
    },
  },

  beauty_personal_care: {
    label: "Beauty & Personal Care",
    subcategories: {
      grooming: "Grooming",
      skincare: "Skincare",
      haircare: "Haircare",
      fragrance: "Fragrance",
      personal_hygiene: "Personal Hygiene",
      wellness_devices: "Wellness Devices",
    },
  },

  fitness_sports: {
    label: "Fitness & Sports",
    subcategories: {
      gym_equipment: "Gym Equipment",
      yoga_fitness: "Yoga & Fitness",
      sports_gear: "Sports Gear",
      outdoor_fitness: "Outdoor Fitness",
      recovery_support: "Recovery & Support",
    },
  },

  office_productivity: {
    label: "Office & Productivity",
    subcategories: {
      office_supplies: "Office Supplies",
      stationery: "Stationery",
      chairs_desks: "Chairs & Desks",
      study_tools: "Study Tools",
      printers_accessories: "Printers & Accessories",
    },
  },

  automotive: {
    label: "Automotive",
    subcategories: {
      car_accessories: "Car Accessories",
      bike_accessories: "Bike Accessories",
      safety_maintenance: "Safety & Maintenance",
      car_electronics: "Car Electronics",
    },
  },

  kids_toys: {
    label: "Kids & Toys",
    subcategories: {
      toys: "Toys",
      learning_education: "Learning & Education",
      baby_care: "Baby Care",
      school_supplies: "School Supplies",
    },
  },

  tools_utilities: {
    label: "Tools & Utilities",
    subcategories: {
      power_tools: "Power Tools",
      hand_tools: "Hand Tools",
      electricals: "Electricals",
      hardware: "Hardware",
      safety_equipment: "Safety Equipment",
    },
  },

  other: {
    label: "Other",
    subcategories: {
      other: "Other",
    },
  },
};

/* ---------------------------
   Helper exports
---------------------------- */

function isValidCategory(category) {
  return !!TAXONOMY[category];
}

function isValidSubcategory(category, subcategory) {
  return (
    isValidCategory(category) &&
    !!TAXONOMY[category].subcategories[subcategory]
  );
}

function listCategories() {
  return Object.entries(TAXONOMY).map(([key, v]) => ({
    key,
    label: v.label,
  }));
}

function listSubcategories(category) {
  if (!isValidCategory(category)) return [];
  return Object.entries(TAXONOMY[category].subcategories).map(
    ([key, label]) => ({ key, label })
  );
}

module.exports = {
  TAXONOMY,
  isValidCategory,
  isValidSubcategory,
  listCategories,
  listSubcategories,
};
