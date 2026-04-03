-- Digital Twin Truck Configurator - Data Setup
-- Run this script after 01_infrastructure.sql

USE SCHEMA BOM.BOM4;

-- ============================================
-- Create Tables
-- ============================================

CREATE OR REPLACE TABLE MODEL_TBL (
    MODEL_ID VARCHAR(50) NOT NULL,
    MODEL_NM VARCHAR(100) NOT NULL,
    TRUCK_DESCRIPTION VARCHAR(2000),
    BASE_MSRP NUMBER(12,2) NOT NULL,
    BASE_WEIGHT_LBS NUMBER(10,2) NOT NULL,
    MAX_PAYLOAD_LBS NUMBER(38,0),
    MAX_TOWING_LBS NUMBER(38,0),
    SLEEPER_AVAILABLE BOOLEAN DEFAULT FALSE,
    MODEL_TIER VARCHAR(20),
    PRIMARY KEY (MODEL_ID)
);

CREATE OR REPLACE TABLE BOM_TBL (
    OPTION_ID VARCHAR(50) NOT NULL,
    SYSTEM_NM VARCHAR(100) NOT NULL,
    SUBSYSTEM_NM VARCHAR(100) NOT NULL,
    COMPONENT_GROUP VARCHAR(100) NOT NULL,
    OPTION_NM VARCHAR(150) NOT NULL,
    COST_USD NUMBER(12,2) NOT NULL,
    WEIGHT_LBS NUMBER(10,2) NOT NULL,
    SOURCE_COUNTRY VARCHAR(50) NOT NULL,
    PERFORMANCE_CATEGORY VARCHAR(50) NOT NULL,
    PERFORMANCE_SCORE NUMBER(3,1) NOT NULL,
    DESCRIPTION VARCHAR(500),
    OPTION_TIER VARCHAR(20),
    SPECS VARIANT,
    PRIMARY KEY (OPTION_ID)
);

CREATE OR REPLACE TABLE TRUCK_OPTIONS (
    MODEL_ID VARCHAR(50) NOT NULL,
    OPTION_ID VARCHAR(50) NOT NULL,
    IS_DEFAULT BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (MODEL_ID, OPTION_ID)
);

-- ============================================
-- Insert Model Data
-- ============================================

INSERT INTO MODEL_TBL (MODEL_ID, MODEL_NM, TRUCK_DESCRIPTION, BASE_MSRP, BASE_WEIGHT_LBS, MAX_PAYLOAD_LBS, MAX_TOWING_LBS, SLEEPER_AVAILABLE, MODEL_TIER) VALUES
('MDL-REGIONAL', 'Regional Hauler RT-500', 'The RT-500 Regional Hauler is a versatile medium-duty box truck designed for efficient urban and regional distribution under 300 miles. This Class 6 straight truck features an integrated 24-foot dry van body, eliminating the need for separate trailer hookups and enabling single-driver deliveries. The 6.7-liter diesel engine provides optimal fuel efficiency for stop-and-go city routes while meeting all emissions requirements. The cab-forward design with large windshield offers excellent visibility for navigating tight urban environments, loading docks, and residential areas. Standard features include a comfortable cloth interior, air conditioning, power accessories, and basic telematics for fleet tracking. The low deck height and optional lift gate simplify loading and unloading operations. The RT-500 excels at last-mile delivery, LTL distribution, and local pickup/delivery operations where maneuverability and accessibility matter most.', 45000, 12000, 15000, 20000, FALSE, 'ENTRY'),
('MDL-FLEET', 'Fleet Workhorse FW-700', 'The FW-700 Fleet Workhorse is the backbone of commercial trucking operations, designed for maximum uptime and minimal total cost of ownership. This mid-roof sleeper configuration accommodates team driving operations while keeping acquisition costs manageable. Built with durability-focused components including reinforced frame rails, heavy-duty clutch, and vocational-grade suspension, the FW-700 handles the demanding schedules of fleet operations. The 13-liter engine provides ample power for general freight while maintaining competitive fuel economy. Interior appointments prioritize durability with fleet vinyl surfaces that withstand years of hard use. Standard driver-controlled differential lock provides traction when needed. The FW-700 is the smart choice for fleet managers who need reliable, cost-effective tractors that drivers can depend on mile after mile.', 65000, 15000, 25000, 35000, FALSE, 'FLEET'),
('MDL-LONGHAUL', 'Cross Country Pro CC-900', 'The CC-900 Cross Country Pro is purpose-built for coast-to-coast over-the-road operations. The spacious 72-inch high-roof sleeper provides genuine living space for drivers spending extended periods on the road, featuring a premium cloth interior, automatic climate control with sleeper zone, and comprehensive storage solutions. Powered by a 13-liter high-output engine with 455 horsepower, the CC-900 delivers the performance needed for varied terrain while the 12-speed automated transmission maximizes fuel efficiency. Advanced aerodynamics including integrated roof fairing and chassis skirts reduce drag for improved MPG on long highway runs. The air-ride cab suspension and premium air-ride driver seat minimize fatigue during long shifts. Standard adaptive cruise control and lane departure warning enhance safety on monotonous interstate miles. Dual 120-gallon fuel tanks provide the range serious long-haul operators demand.', 85000, 17000, 45000, 60000, TRUE, 'STANDARD'),
('MDL-HEAVYHAUL', 'Heavy Haul Max HH-1200', 'The HH-1200 Heavy Haul Max represents the ultimate in pulling power and durability for specialized heavy-haul operations. The flagship 15-liter engine produces 565 horsepower and 2,050 lb-ft of torque, mated to an 18-speed heavy-duty automated transmission with launch assist for confident starts with maximum loads. The reinforced alloy frame rails, 20,000-pound front axle, and severe-duty tandem rear suspension handle gross combination weights that would overwhelm lesser trucks. The practical 60-inch flat-top sleeper provides rest accommodations while keeping overall height manageable for varied routing requirements. Heavy-duty engine braking provides control on steep descents, complemented by disc brakes with electronic stability control at all wheel positions. Dual PTOs support hydraulic equipment for specialized applications. The weight-optimized design maximizes payload capacity for heavy permitted loads. The HH-1200 is the truck you spec when the load demands the best and efficiency matters.', 110000, 19000, 80000, 120000, TRUE, 'HEAVY_DUTY'),
('MDL-PREMIUM', 'Executive Hauler EX-1500', 'The EX-1500 Executive Hauler is the flagship of our lineup, designed for discerning owner-operators who demand the finest in comfort, efficiency, and technology. The ultra-high 80-inch sleeper cabin features a luxury leather interior with wood-look trim, premium memory foam mattress, and independent climate control that operates on battery power for true idle-free comfort. The lightweight alloy frame rails and premium aluminum wheels reduce tare weight for maximum payload potential. The 15-liter 505-horsepower engine delivers strong performance with exceptional fuel economy, aided by advanced aerodynamics and low-rolling-resistance tires. The full digital cockpit integrates heads-up display, 360-degree camera system, and semi-autonomous driving capabilities for reduced driver fatigue. A premium Lithium house battery bank powers the hotel loads without engine idle. Every detail of the EX-1500 is optimized for the owner-operator who views their truck as both a business tool and a home on the road.', 125000, 18000, 50000, 70000, TRUE, 'PREMIUM');

-- ============================================
-- Insert BOM Data (Bill of Materials)
-- Note: This is a subset - full data in data/bom_data.csv
-- ============================================

-- Load remaining BOM data from the separate file
-- You can either:
-- 1. Run scripts/02b_bom_data.sql for full INSERT statements
-- 2. Or use COPY INTO from the CSV file in data/bom_data.csv

-- Sample BOM entries (first 50 for quick testing)
INSERT INTO BOM_TBL (OPTION_ID, SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP, OPTION_NM, COST_USD, WEIGHT_LBS, SOURCE_COUNTRY, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, DESCRIPTION, OPTION_TIER) VALUES
('1', 'Cab', 'Cab Structure', 'Cab Type', 'Day Cab Standard', 0, 1200, 'USA', 'Comfort', 1, 'Basic day cab for regional and local operations. No sleeping quarters.', 'ENTRY'),
('2', 'Cab', 'Cab Structure', 'Cab Type', 'Low-Entry Day Cab', 1500, 1250, 'USA', 'Comfort', 1.5, 'Lower step-in height.', 'STANDARD'),
('3', 'Cab', 'Cab Structure', 'Cab Type', 'Day Cab Extended', 2500, 1350, 'USA', 'Comfort', 2.5, 'Extended day cab with additional storage and legroom.', 'STANDARD'),
('4', 'Cab', 'Cab Structure', 'Cab Type', 'Sleeper 48-inch Flat Roof', 6500, 1800, 'USA', 'Comfort', 3, 'Compact sleeper for budget-conscious fleets.', 'STANDARD'),
('5', 'Cab', 'Cab Structure', 'Cab Type', 'Crew Cab 4-Door', 8500, 1650, 'USA', 'Comfort', 3.5, 'Four-door crew cab for vocational.', 'STANDARD'),
('6', 'Cab', 'Cab Structure', 'Cab Type', 'Sleeper 72-inch Mid Roof', 12000, 2200, 'USA', 'Comfort', 4.5, 'Mid-roof sleeper with stand-up height.', 'PREMIUM'),
('7', 'Cab', 'Cab Structure', 'Cab Type', 'Sleeper 80-inch Raised Roof', 22000, 2600, 'USA', 'Comfort', 5, 'Full-height raised roof sleeper.', 'FLAGSHIP'),
('8', 'Cab', 'Climate Control', 'HVAC System', 'Manual Climate Control', 0, 45, 'Mexico', 'Comfort', 1, 'Basic manual HVAC with heater and A/C.', 'ENTRY'),
('9', 'Cab', 'Climate Control', 'HVAC System', 'Automatic Climate Control', 1200, 52, 'USA', 'Comfort', 2, 'Single-zone automatic temperature control.', 'STANDARD'),
('10', 'Cab', 'Climate Control', 'HVAC System', 'High-Capacity A/C', 1800, 58, 'USA', 'Comfort', 2.5, 'Extra cooling capacity.', 'STANDARD');

-- Note: Full BOM data (253 rows) is in scripts/02b_bom_data.sql or data/bom_data.csv
-- Run: source scripts/02b_bom_data.sql  OR  use COPY INTO from CSV

-- ============================================
-- Verification
-- ============================================
SELECT 'MODEL_TBL' as table_name, COUNT(*) as row_count FROM MODEL_TBL
UNION ALL
SELECT 'BOM_TBL', COUNT(*) FROM BOM_TBL
UNION ALL  
SELECT 'TRUCK_OPTIONS', COUNT(*) FROM TRUCK_OPTIONS;
