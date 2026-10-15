-- Starting data: the two members and the Household pot, and the expense categories. No passwords here —
-- credentials are created in the sign-in step. Safe to run again.
insert into members (id, kind, display_name, role, earning, color) values
  ('bhawneet', 'person', 'Bhawneet', 'admin',  true,  '#4b7bec'),
  ('gurneet',  'person', 'Gurneet',  'member', true,  '#c264d0'),
  ('common',   'common', 'Household', 'member', false, '#1f9d6b')
on conflict (id) do nothing;

insert into categories (name, color, subs) values
  ('Food & Groceries', '#1f9d6b', '{"Vegetables & Fruits","Milk & Dairy","Rashan / Staples","Snacks & Packaged food","Meat, Fish & Eggs","Bakery","Online grocery","Tiffin / Catering"}'),
  ('Eating Out', '#e07a3a', '{"Restaurants","Online food delivery","Cafes & Tea","Street food & Sweets","Office / Canteen"}'),
  ('Home & Utilities', '#4b7bec', '{"Rent","Electricity","Water","Gas / Cylinder","Internet & Broadband","Mobile & DTH","Society maintenance","House help (Maid / Cook)","Repairs & Maintenance"}'),
  ('Education', '#3a7bd5', '{"School fee","Uniform","Books & Stationery","Tuition & Coaching","School transport","Online courses"}'),
  ('Kids & Childcare', '#f08fb0', '{"Toys & Games","Daycare / Creche","Baby care","Pocket money","Kids clothing","Birthday & Parties"}'),
  ('Health', '#2fb08a', '{"Doctor & Consultation","Medicines","Diagnostics & Labs","Hospital","Dental & Eye care","Gym & Fitness","Supplements & Wellness"}'),
  ('Vehicles & Travel', '#e8963a', '{"Fuel","Parking","Toll / FASTag","Service & Repairs","Cab / Auto / Taxi","Public transport","Flights & Trains","Hotels & Stay","Holiday"}'),
  ('Insurance & Taxes', '#b0479a', '{"Health insurance","Life insurance","Vehicle insurance","Home insurance","Property tax","Income tax","GST & other taxes"}'),
  ('Shopping', '#c264d0', '{"Clothing & Footwear","Electronics & Gadgets","Accessories & Jewellery","Home & Kitchen","Online shopping","Books & Media"}'),
  ('Personal Care', '#e58ab0', '{"Salon & Grooming","Cosmetics & Skincare","Spa & Massage"}'),
  ('Entertainment & Leisure', '#d9a21b', '{"Movies & Events","Games","Outings & Hobbies","Sports & Clubs","Concerts & Shows"}'),
  ('Subscriptions', '#5bc0d0', '{"OTT / Streaming","Music","Cloud storage","Software & Apps","News & Magazines","Mobile postpaid"}'),
  ('Loans & EMIs', '#6d4bd8', '{"Home loan","Car loan","Personal loan","Education loan","Gold loan","Credit card EMI","Pay Later EMI","Consumer durable EMI"}'),
  ('Gifts & Donations', '#e0566b', '{"Gifts","Festivals","Charity & Donations","Religious"}'),
  ('Family & Dependents', '#8c6bd0', '{"Parents’ support","Support to relatives","Pocket money"}'),
  ('Pets', '#a9744f', '{"Food","Vet & Medicines","Grooming","Accessories"}'),
  ('Fees & Charges', '#7f8aa3', '{"Bank charges","Late fee / Penalty","Convenience fee","Interest charged"}'),
  ('Other', '#9b93b8', '{"Miscellaneous"}')
on conflict (name) do nothing;
