// The category tree (Mint-style: parent → subcategories) and how Plaid's
// personal finance categories map onto it. Category names are unique across the
// whole tree, so a name alone identifies a category; a transaction or budget
// can use a parent ("Food & Dining") or a subcategory ("Groceries").

const TREE = [
  ['Auto & Transport', ['Auto Insurance', 'Auto Payment', 'Gas & Fuel', 'Parking', 'Public Transportation', 'Service & Parts']],
  ['Bills & Utilities', ['Domain & Hosting', 'Electricity', 'Garbage & Recycling', 'Home Phone', 'Internet', 'Mobile Phone', 'Television', 'Utilities']],
  ['Business Services', ['Advertising', 'Legal', 'Office Supplies', 'Printing', 'Shipping']],
  ['Education', ['Books & Supplies', 'Student Loan', 'Tuition']],
  ['Entertainment', ['Amusement', 'Arts', 'Movies & DVDs', 'Music', 'Newspaper & Magazines']],
  ['Fees & Charges', ['ATM Fee', 'Bank Fee', 'Finance Charge', 'Late Fee', 'Service Fee', 'Trade Commissions']],
  ['Financial', ['Financial Advisor', 'Life Insurance']],
  ['Food & Dining', ['Alcohol & Bars', 'Coffee Shops', 'Fast Food', 'Groceries', 'Restaurants']],
  ['Gifts & Donations', ['Charity', 'Gift']],
  ['Health & Fitness', ['Dentist', 'Doctor', 'Eyecare', 'Gym', 'Health Insurance', 'Pharmacy', 'Sports']],
  ['Home', ['Furnishings', 'Home Improvement', 'Home Insurance', 'Home Services', 'Home Supplies', 'Lawn & Garden', 'Mortgage & Rent']],
  ['Income', ['Bonus', 'Interest Income', 'Paycheck', 'Reimbursement', 'Rental Income']],
  ['Investments', ['Buy', 'Deposit', 'Dividend & Cap Gains', 'Sell', 'Withdrawal']],
  ['Kids', ['Allowance', 'Baby Supplies', 'Child Support', 'Daycare', 'Kids Activities', 'Toys']],
  ['Personal Care', ['Hair', 'Laundry', 'Spa & Massage']],
  ['Pets', ['Pet Food & Supplies', 'Pet Grooming', 'Veterinary']],
  ['Shopping', ['Books', 'Clothing', 'Electronics & Software', 'Hobbies', 'Sporting Goods']],
  ['Taxes', ['Federal Tax', 'Local Tax', 'Property Tax', 'State Tax']],
  ['Travel', ['Air Travel', 'Hotel', 'Rental Car', 'Vacation']],
  ['Transfer', ['Credit Card Payment', 'Transfer for Cash Requirement']],
  ['Uncategorized', []],
  ['Hide from Budgets & Trends', []],
];

const PARENT_OF = new Map();
for (const [parent, subs] of TREE) {
  PARENT_OF.set(parent, parent);
  for (const s of subs) PARENT_OF.set(s, parent);
}
const isKnownCategory = (c) => PARENT_OF.has(c);
const parentOf = (c) => PARENT_OF.get(c) || 'Uncategorized';
const UNCATEGORIZED = 'Uncategorized';

// Money that isn't income or spending: moving it between your own accounts
// (counting it would double-count: a card payment, then the purchases it pays
// for), investment trades, and anything you chose to hide.
const isExcluded = (c) => {
  const p = parentOf(c);
  return p === 'Transfer' || p === 'Hide from Budgets & Trends' || (p === 'Investments' && c !== 'Dividend & Cap Gains');
};
const isIncome = (c) => parentOf(c) === 'Income' || c === 'Dividend & Cap Gains';

// Plaid detailed category → our category. Anything not listed falls back to
// its Plaid primary (PRIMARY_MAP).
const DETAILED_MAP = {
  // Income
  INCOME_WAGES: 'Paycheck',
  INCOME_INTEREST_EARNED: 'Interest Income',
  INCOME_DIVIDENDS: 'Dividend & Cap Gains',
  INCOME_RETIREMENT_PENSION: 'Income',
  INCOME_TAX_REFUND: 'Income',
  INCOME_UNEMPLOYMENT: 'Income',
  // Transfers
  TRANSFER_OUT_WITHDRAWAL: 'Transfer for Cash Requirement',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Credit Card Payment',
  // Loans
  LOAN_PAYMENTS_CAR_PAYMENT: 'Auto Payment',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Mortgage & Rent',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'Student Loan',
  // Fees
  BANK_FEES_ATM_FEES: 'ATM Fee',
  BANK_FEES_FOREIGN_TRANSACTION_FEES: 'Bank Fee',
  BANK_FEES_INSUFFICIENT_FUNDS: 'Bank Fee',
  BANK_FEES_INTEREST_CHARGE: 'Finance Charge',
  BANK_FEES_OVERDRAFT_FEES: 'Bank Fee',
  BANK_FEES_OTHER_BANK_FEES: 'Bank Fee',
  // Entertainment
  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'Amusement',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'Music',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'Amusement',
  ENTERTAINMENT_TV_AND_MOVIES: 'Movies & DVDs',
  ENTERTAINMENT_VIDEO_GAMES: 'Amusement',
  // Food
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'Alcohol & Bars',
  FOOD_AND_DRINK_COFFEE: 'Coffee Shops',
  FOOD_AND_DRINK_FAST_FOOD: 'Fast Food',
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  FOOD_AND_DRINK_RESTAURANT: 'Restaurants',
  FOOD_AND_DRINK_VENDING_MACHINES: 'Fast Food',
  // Shopping
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: 'Books',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'Clothing',
  GENERAL_MERCHANDISE_ELECTRONICS: 'Electronics & Software',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gift',
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: 'Office Supplies',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'Pet Food & Supplies',
  GENERAL_MERCHANDISE_SPORTING_GOODS: 'Sporting Goods',
  // Services
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: 'Financial Advisor',
  GENERAL_SERVICES_AUTOMOTIVE: 'Service & Parts',
  GENERAL_SERVICES_CHILDCARE: 'Daycare',
  GENERAL_SERVICES_CONSULTING_AND_LEGAL: 'Legal',
  GENERAL_SERVICES_EDUCATION: 'Education',
  GENERAL_SERVICES_INSURANCE: 'Financial',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'Shipping',
  GENERAL_SERVICES_STORAGE: 'Home Services',
  // Government & non-profit
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Charity',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'Taxes',
  // Home
  HOME_IMPROVEMENT_FURNITURE: 'Furnishings',
  HOME_IMPROVEMENT_HARDWARE: 'Home Improvement',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'Home Services',
  HOME_IMPROVEMENT_SECURITY: 'Home Services',
  // Health
  MEDICAL_DENTAL_CARE: 'Dentist',
  MEDICAL_EYE_CARE: 'Eyecare',
  MEDICAL_NURSING_CARE: 'Doctor',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'Pharmacy',
  MEDICAL_PRIMARY_CARE: 'Doctor',
  MEDICAL_VETERINARY_SERVICES: 'Veterinary',
  // Personal care
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Gym',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'Hair',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'Laundry',
  // Bills
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'Electricity',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'Internet',
  RENT_AND_UTILITIES_RENT: 'Mortgage & Rent',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'Garbage & Recycling',
  RENT_AND_UTILITIES_TELEPHONE: 'Mobile Phone',
  RENT_AND_UTILITIES_WATER: 'Utilities',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'Utilities',
  // Transport
  TRANSPORTATION_GAS: 'Gas & Fuel',
  TRANSPORTATION_PARKING: 'Parking',
  TRANSPORTATION_PUBLIC_TRANSIT: 'Public Transportation',
  // Travel
  TRAVEL_FLIGHTS: 'Air Travel',
  TRAVEL_LODGING: 'Hotel',
  TRAVEL_RENTAL_CARS: 'Rental Car',
};

const PRIMARY_MAP = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  LOAN_PAYMENTS: 'Financial',
  BANK_FEES: 'Fees & Charges',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Health & Fitness',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: UNCATEGORIZED, // too broad to guess (a dance studio, a lawyer, a car wash…)
  GOVERNMENT_AND_NON_PROFIT: 'Taxes',
  TRANSPORTATION: 'Auto & Transport',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  OTHER: UNCATEGORIZED,
};

// Plaid category (primary + detailed) → our category name.
function fromPlaid(primary, detailed) {
  if (detailed && DETAILED_MAP[detailed]) return DETAILED_MAP[detailed];
  if (primary && PRIMARY_MAP[primary]) return PRIMARY_MAP[primary];
  return UNCATEGORIZED;
}

// Budgets, rules and fixes saved before this tree used Plaid primaries
// (e.g. FOOD_AND_DRINK). Translate those; pass current names through.
const fromLegacy = (c) => (isKnownCategory(c) ? c : PRIMARY_MAP[c] || (c === 'UNCATEGORIZED' ? UNCATEGORIZED : null));

module.exports = { TREE, isKnownCategory, parentOf, isExcluded, isIncome, fromPlaid, fromLegacy, UNCATEGORIZED };
