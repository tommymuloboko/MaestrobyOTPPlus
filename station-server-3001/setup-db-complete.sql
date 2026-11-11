-- ============================================================
-- MAESTRO COMPLETE DATABASE SETUP SCRIPT
-- Run this on a fresh "maestroroma" PostgreSQL database
-- ============================================================

-- ──────────────────────────────────────────
-- STEP 1: SEQUENCES (must exist before tables)
-- ──────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS fuel_transactions_raw_id_seq;
CREATE SEQUENCE IF NOT EXISTS pts_sales_id_seq;
CREATE SEQUENCE IF NOT EXISTS rfid_authorizations_authorization_id_seq;
CREATE SEQUENCE IF NOT EXISTS rfid_reader_pumps_id_seq;
CREATE SEQUENCE IF NOT EXISTS rfid_readers_reader_id_seq;
CREATE SEQUENCE IF NOT EXISTS rfid_transactions_transaction_id_seq;
CREATE SEQUENCE IF NOT EXISTS sync_queue_id_seq;
CREATE SEQUENCE IF NOT EXISTS pending_transactions_id_seq;
CREATE SEQUENCE IF NOT EXISTS price_change_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS pump_report_transactions_id_seq;

-- ──────────────────────────────────────────
-- STEP 2: CORE TABLES
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."companies" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "code" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companies_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."stations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "code" text NOT NULL,
  "timezone" text,
  "location" text,
  "station_url" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."roles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  CONSTRAINT roles_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid,
  "username" text NOT NULL,
  "password_hash" text NOT NULL,
  "full_name" text,
  "email" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_username_key UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS public."user_roles" (
  "user_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public."employees" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "user_id" uuid,
  "employee_no" text,
  "full_name" text NOT NULL,
  "job_title" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT employees_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."attendants" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "full_name" text NOT NULL,
  "phone" text,
  "email" text,
  "nrc" text,
  "country" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "tag_number" text,
  "blocked" boolean DEFAULT false,
  "authorized_pumps" integer[],
  "synced" boolean NOT NULL DEFAULT false,
  CONSTRAINT attendants_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."pumps" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "station_id" uuid NOT NULL,
  "pts2_pump_id" integer NOT NULL,
  "name" text,
  "is_active" boolean NOT NULL DEFAULT true,
  CONSTRAINT pumps_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."tanks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "station_id" uuid NOT NULL,
  "pts2_tank_id" integer NOT NULL,
  "name" text,
  "fuel_grade" text,
  "capacity_liters" numeric,
  "is_active" boolean NOT NULL DEFAULT true,
  CONSTRAINT tanks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."tank_readings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tank_id" uuid NOT NULL,
  "reading_time" timestamp with time zone NOT NULL,
  "level_liters" numeric,
  "temperature" numeric,
  "water_level" numeric,
  CONSTRAINT tank_readings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."audit_log" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid,
  "actor_user_id" uuid,
  "action" text NOT NULL,
  "entity_table" text NOT NULL,
  "entity_pk" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 3: SHIFT TABLES
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."shifts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "start_datetime" timestamp with time zone NOT NULL DEFAULT now(),
  "end_datetime" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'open',
  "attendant_mode" text NOT NULL DEFAULT 'manual',
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "synced" boolean NOT NULL DEFAULT false,
  CONSTRAINT shifts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."shift_attendants" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid NOT NULL,
  "attendant_id" uuid NOT NULL,
  "pump_id" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shift_attendants_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."attendant_shifts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "attendant_id" uuid NOT NULL,
  "tag_number" text,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "is_open" boolean NOT NULL DEFAULT true,
  "is_ended" boolean NOT NULL DEFAULT false,
  "is_pending_verification" boolean NOT NULL DEFAULT false,
  "is_verified" boolean NOT NULL DEFAULT false,
  "is_disputed" boolean NOT NULL DEFAULT false,
  "opened_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT attendant_shifts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."attendant_tags" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "attendant_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "tag_number" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  CONSTRAINT attendant_tags_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."shift_cashup" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid NOT NULL,
  "pump_id" integer NOT NULL,
  "attendant_id" uuid,
  "pts_total" numeric NOT NULL DEFAULT 0,
  "declared_card" numeric NOT NULL DEFAULT 0,
  "declared_mobile" numeric NOT NULL DEFAULT 0,
  "declared_debtor" numeric NOT NULL DEFAULT 0,
  "debtor_id" uuid,
  "declared_cash" numeric NOT NULL DEFAULT 0,
  "declared_total" numeric NOT NULL DEFAULT 0,
  "variance" numeric NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shift_cashup_pkey PRIMARY KEY (id),
  CONSTRAINT shift_cashup_unique_shift_pump UNIQUE (shift_id, pump_id)
);

CREATE TABLE IF NOT EXISTS public."shift_close_declarations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid NOT NULL,
  "declared_cash" numeric NOT NULL DEFAULT 0,
  "declared_card" numeric NOT NULL DEFAULT 0,
  "declared_debtors" numeric NOT NULL DEFAULT 0,
  "declared_other" jsonb,
  "declared_total" numeric NOT NULL DEFAULT 0,
  "currency" character(3) NOT NULL DEFAULT 'ZMW',
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shift_close_declarations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."shift_verification_summary" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid NOT NULL,
  "computed_total" numeric NOT NULL,
  "declared_total" numeric NOT NULL,
  "verified_total" numeric NOT NULL,
  "variance_amount" numeric NOT NULL,
  "currency" character(3) NOT NULL DEFAULT 'ZMW',
  "is_verified" boolean NOT NULL DEFAULT false,
  "is_disputed" boolean NOT NULL DEFAULT false,
  "notes" text,
  "verified_by_user_id" uuid,
  "verified_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shift_verification_summary_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 4: PTS / FUEL TRANSACTION TABLES
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."fuel_transactions_raw" (
  "id" bigint NOT NULL DEFAULT nextval('fuel_transactions_raw_id_seq'::regclass),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "shift_id" uuid,
  "attendant_id" uuid,
  "tag_number" text,
  "full_name" text,
  "pump_id" integer NOT NULL,
  "time" timestamp with time zone NOT NULL,
  "amount" numeric NOT NULL,
  "currency" character(3) NOT NULL DEFAULT 'ZMW',
  "transaction_id" integer NOT NULL,
  "is_verified" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fuel_transactions_raw_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_transactions_verified" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "raw_id" bigint NOT NULL,
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "shift_id" uuid,
  "attendant_id" uuid,
  "payment_type" text NOT NULL,
  "verified_by_user_id" uuid,
  "verified_at" timestamp with time zone NOT NULL DEFAULT now(),
  "amount" numeric NOT NULL,
  "currency" character(3) NOT NULL DEFAULT 'ZMW',
  "time" timestamp with time zone NOT NULL,
  "tag_number" text,
  "full_name" text,
  "pump_id" integer NOT NULL,
  "transaction_id" integer NOT NULL,
  CONSTRAINT fuel_transactions_verified_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."pts_sales" (
  "id" bigint NOT NULL DEFAULT nextval('pts_sales_id_seq'::regclass),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "pump_id" integer NOT NULL,
  "nozzle" integer,
  "fuel_grade" text,
  "fuel_grade_id" integer,
  "volume" numeric NOT NULL,
  "amount" numeric NOT NULL,
  "unit_price" numeric,
  "currency" character(3) NOT NULL DEFAULT 'ZMW',
  "pts_transaction_id" integer NOT NULL,
  "transaction_state" text NOT NULL DEFAULT 'Completed',
  "start_time" timestamp with time zone,
  "end_time" timestamp with time zone,
  "polled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pts_sales_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."pts_sales_records" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid,
  "date_time" timestamp with time zone,
  "date_time_start" timestamp with time zone,
  "pump" integer,
  "nozzle" integer,
  "fuel_grade_id" integer,
  "fuel_grade_name" text,
  "transaction_no" integer,
  "user_id_pts" text,
  "volume" numeric NOT NULL DEFAULT 0,
  "amount" numeric NOT NULL DEFAULT 0,
  "price" numeric NOT NULL DEFAULT 0,
  "total_volume" numeric NOT NULL DEFAULT 0,
  "total_amount" numeric NOT NULL DEFAULT 0,
  "tc_volume" numeric NOT NULL DEFAULT 0,
  "flow_rate" numeric,
  "is_offline" boolean NOT NULL DEFAULT false,
  "is_paid" boolean NOT NULL DEFAULT false,
  "tag" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pts_sales_records_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."pump_report_transactions" (
  "id" bigint NOT NULL DEFAULT nextval('pump_report_transactions_id_seq'::regclass),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "pump_id" integer NOT NULL,
  "nozzle" integer,
  "fuel_grade_id" integer,
  "fuel_grade_name" text,
  "transaction_number" integer NOT NULL,
  "volume" numeric NOT NULL DEFAULT 0,
  "tc_volume" numeric,
  "price" numeric,
  "amount" numeric NOT NULL DEFAULT 0,
  "total_volume" numeric,
  "total_amount" numeric,
  "tag" text,
  "flow_rate" numeric,
  "is_offline" boolean NOT NULL DEFAULT false,
  "is_paid" boolean NOT NULL DEFAULT false,
  "pts_user_id" text,
  "start_time" timestamp with time zone,
  "end_time" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pump_report_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT pump_report_transactions_station_txn_key UNIQUE (station_id, transaction_number)
);

-- ──────────────────────────────────────────
-- STEP 5: RFID TABLES
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."rfid_readers" (
  "reader_id" integer NOT NULL DEFAULT nextval('rfid_readers_reader_id_seq'::regclass),
  "company_id" uuid,
  "station_id" uuid,
  "reader_name" character varying(50) NOT NULL,
  "ip_address" character varying(15) NOT NULL,
  "port" integer NOT NULL DEFAULT 9761,
  "device_address" smallint NOT NULL DEFAULT 0,
  "pump_ids" integer[] NOT NULL DEFAULT '{}',
  "pump_id" integer,
  "location" character varying(100),
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT rfid_readers_pkey PRIMARY KEY (reader_id),
  CONSTRAINT rfid_readers_ip_port_key UNIQUE (ip_address, port)
);

CREATE TABLE IF NOT EXISTS public."rfid_reader_pumps" (
  "id" integer NOT NULL DEFAULT nextval('rfid_reader_pumps_id_seq'::regclass),
  "reader_id" integer NOT NULL,
  "pump_id" integer NOT NULL,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT rfid_reader_pumps_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."rfid_authorizations" (
  "authorization_id" integer NOT NULL DEFAULT nextval('rfid_authorizations_authorization_id_seq'::regclass),
  "reader_id" integer,
  "attendant_id" uuid,
  "tag_number" character varying(32) NOT NULL,
  "pump_id" integer,
  "authorized" boolean NOT NULL,
  "pts_transaction_id" integer,
  "authorization_datetime" timestamp with time zone DEFAULT now(),
  "denial_reason" character varying(255),
  CONSTRAINT rfid_authorizations_pkey PRIMARY KEY (authorization_id)
);

CREATE TABLE IF NOT EXISTS public."rfid_transactions" (
  "transaction_id" integer NOT NULL DEFAULT nextval('rfid_transactions_transaction_id_seq'::regclass),
  "authorization_id" integer,
  "pump_id" integer NOT NULL,
  "attendant_id" uuid,
  "tag_number" character varying(32) NOT NULL,
  "pts_transaction_number" integer,
  "nozzle_number" integer,
  "fuel_grade_id" integer,
  "fuel_grade_name" character varying(50),
  "volume" numeric,
  "price" numeric,
  "amount" numeric,
  "start_datetime" timestamp with time zone,
  "end_datetime" timestamp with time zone,
  "status" character varying(20) DEFAULT 'pending',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT rfid_transactions_pkey PRIMARY KEY (transaction_id)
);

CREATE TABLE IF NOT EXISTS public."rfid_tags" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tag_number" text NOT NULL,
  "label" text,
  "company_id" uuid,
  "station_id" uuid,
  "attendant_id" uuid,
  "notes" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "registered_at" timestamp with time zone DEFAULT now(),
  "assigned_at" timestamp with time zone,
  CONSTRAINT rfid_tags_pkey PRIMARY KEY (id),
  CONSTRAINT rfid_tags_tag_number_station_key UNIQUE (tag_number, station_id)
);

CREATE TABLE IF NOT EXISTS public."rfid_shifts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "created_by" uuid,
  "start_datetime" timestamp with time zone NOT NULL DEFAULT now(),
  "end_datetime" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT rfid_shifts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."rfid_shift_cashup" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" uuid NOT NULL,
  "attendant_id" uuid NOT NULL,
  "tag_number" text,
  "attendant_name" text,
  "pts_total" numeric NOT NULL DEFAULT 0,
  "pts_volume" numeric NOT NULL DEFAULT 0,
  "pts_count" integer NOT NULL DEFAULT 0,
  "declared_cash" numeric NOT NULL DEFAULT 0,
  "declared_card" numeric NOT NULL DEFAULT 0,
  "declared_mobile" numeric NOT NULL DEFAULT 0,
  "declared_debtor" numeric NOT NULL DEFAULT 0,
  "declared_total" numeric NOT NULL DEFAULT 0,
  "variance" numeric NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT rfid_shift_cashup_pkey PRIMARY KEY (id),
  CONSTRAINT rfid_shift_cashup_shift_attendant_key UNIQUE (shift_id, attendant_id)
);

-- ──────────────────────────────────────────
-- STEP 6: DEBTOR TABLES
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."debtors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "station_id" uuid,
  "account_number" text NOT NULL,
  "company_name" text NOT NULL,
  "title_initials" text,
  "account_type" text NOT NULL DEFAULT 'balance_brought_forward',
  "vat_reg_no" text,
  "company_reg_no" text,
  "contact1_name" text,
  "contact1_telephone" text,
  "contact1_fax" text,
  "contact1_cell" text,
  "contact1_email" text,
  "contact2_name" text,
  "contact2_telephone" text,
  "contact2_fax" text,
  "contact2_cell" text,
  "contact2_email" text,
  "postal_address" text,
  "physical_address" text,
  "is_main_account" boolean NOT NULL DEFAULT true,
  "main_account_no" text,
  "main_account_name" text,
  "debtor_category" text,
  "credit_limit" numeric NOT NULL DEFAULT 1000.00,
  "terms_of_payment" text NOT NULL DEFAULT 'Cash',
  "charge_interest" boolean NOT NULL DEFAULT false,
  "enter_order_number" boolean NOT NULL DEFAULT false,
  "enter_odometer" boolean NOT NULL DEFAULT false,
  "enter_region_code" boolean NOT NULL DEFAULT false,
  "print_balance" text NOT NULL DEFAULT 'system_default',
  "statement_type" text NOT NULL DEFAULT 'monthly',
  "send_via_print" boolean NOT NULL DEFAULT true,
  "send_via_email" boolean NOT NULL DEFAULT false,
  "account_status" text NOT NULL DEFAULT 'enabled',
  "settlement_discount_pct" numeric NOT NULL DEFAULT 0.00,
  "settlement_terms" text NOT NULL DEFAULT 'Cash',
  "trade_discount_category" text,
  "trade_discount_pct" numeric NOT NULL DEFAULT 0.00,
  "opening_balance" numeric NOT NULL DEFAULT 0.00,
  "current_balance" numeric NOT NULL DEFAULT 0.00,
  "deposit" numeric NOT NULL DEFAULT 0.00,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT debtors_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."debtor_aging" (
  "debtor_id" uuid NOT NULL,
  "current_amount" numeric NOT NULL DEFAULT 0.00,
  "days_30" numeric NOT NULL DEFAULT 0.00,
  "days_60" numeric NOT NULL DEFAULT 0.00,
  "days_90" numeric NOT NULL DEFAULT 0.00,
  "days_120_plus" numeric NOT NULL DEFAULT 0.00,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT debtor_aging_pkey PRIMARY KEY (debtor_id)
);

CREATE TABLE IF NOT EXISTS public."debtor_transactions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "debtor_id" uuid NOT NULL,
  "date" date NOT NULL DEFAULT CURRENT_DATE,
  "type" text NOT NULL,
  "doc_no" text,
  "reference" text,
  "description" text,
  "debit" numeric NOT NULL DEFAULT 0.00,
  "credit" numeric NOT NULL DEFAULT 0.00,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "shift_id" uuid,
  "pts_transaction_id" text,
  "driver_name" text,
  "vehicle_id" uuid,
  "pump_id" integer,
  "amount" numeric DEFAULT 0,
  "volume" numeric DEFAULT 0,
  "fuel_grade" text,
  "price_per_litre" numeric DEFAULT 0,
  "transaction_time" timestamp with time zone,
  CONSTRAINT debtor_transactions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."debtor_vehicles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "debtor_id" uuid NOT NULL,
  "registration" text NOT NULL,
  "driver" text,
  "tag_no" text,
  "grades_allowed" text NOT NULL DEFAULT 'ALL GRADES',
  "card_no" text,
  "restrict_fueling_times" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT debtor_vehicles_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."debtor_vehicle_schedules" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "vehicle_id" uuid NOT NULL,
  "day_of_week" integer NOT NULL,
  "is_allowed" boolean NOT NULL DEFAULT true,
  "time_from" time without time zone NOT NULL DEFAULT '00:00:00',
  "time_to" time without time zone NOT NULL DEFAULT '23:59:00',
  CONSTRAINT debtor_vehicle_schedules_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 7: DRIVERS
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."drivers" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "vehicle_id" uuid,
  "full_name" text NOT NULL,
  "nrc" text,
  "nationality" text NOT NULL DEFAULT 'Zambian',
  "phone" text,
  "email" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT drivers_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 8: PRICE CHANGE LOG
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."price_change_log" (
  "id" bigint NOT NULL DEFAULT nextval('price_change_log_id_seq'::regclass),
  "fuel_grade_id" integer,
  "fuel_grade_name" text,
  "new_price" numeric NOT NULL,
  "changed_by" text,
  "change_type" text,
  "scheduled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT price_change_log_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 9: STATION SETTINGS
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."station_settings" (
  "station_id" uuid NOT NULL,
  "attendant_mode" text NOT NULL DEFAULT 'manual',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT station_settings_pkey PRIMARY KEY (station_id)
);

-- ──────────────────────────────────────────
-- STEP 10: SYNC QUEUE & PENDING TRANSACTIONS
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."sync_queue" (
  "id" bigint NOT NULL DEFAULT nextval('sync_queue_id_seq'::regclass),
  "table_name" text NOT NULL,
  "record_id" text NOT NULL,
  "operation" text NOT NULL,
  "payload" jsonb,
  "is_synced" boolean NOT NULL DEFAULT false,
  "sync_attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "synced_at" timestamp with time zone,
  CONSTRAINT sync_queue_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."pending_transactions" (
  "id" bigint NOT NULL DEFAULT nextval('pending_transactions_id_seq'::regclass),
  "type" text NOT NULL,
  "company_id" uuid,
  "station_id" uuid,
  "data" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pending_transactions_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────
-- STEP 11: INDEXES
-- ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_shifts_station_status ON public.shifts (station_id, status);
CREATE INDEX IF NOT EXISTS idx_shift_attendants_shift ON public.shift_attendants (shift_id);
CREATE INDEX IF NOT EXISTS idx_pts_sales_station ON public.pts_sales (station_id, pts_transaction_id);
CREATE INDEX IF NOT EXISTS idx_pts_sales_records_shift ON public.pts_sales_records (shift_id);
CREATE INDEX IF NOT EXISTS idx_fuel_raw_station ON public.fuel_transactions_raw (station_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_rfid_tags_tag_number ON public.rfid_tags (tag_number);
CREATE INDEX IF NOT EXISTS idx_rfid_tags_station ON public.rfid_tags (station_id);
CREATE INDEX IF NOT EXISTS idx_rfid_shifts_station_status ON public.rfid_shifts (station_id, status);
CREATE INDEX IF NOT EXISTS idx_rfid_auth_tag ON public.rfid_authorizations (tag_number);
CREATE INDEX IF NOT EXISTS idx_sync_queue_is_synced ON public.sync_queue (is_synced);
CREATE INDEX IF NOT EXISTS idx_pump_report_txn_station ON public.pump_report_transactions (station_id, transaction_number);
CREATE INDEX IF NOT EXISTS idx_attendants_tag ON public.attendants (tag_number);
CREATE INDEX IF NOT EXISTS idx_debtors_account_number ON public.debtors (account_number);
CREATE INDEX IF NOT EXISTS idx_debtor_vehicles_debtor ON public.debtor_vehicles (debtor_id);

-- ──────────────────────────────────────────
-- STEP 12: FORECOURT TABLES FROM MAESTRO POS (fuel_*)
-- Mirrors react-app/electron/db.cjs, converted to Postgres the same way the POS
-- does it (INTEGER -> bigint, REAL -> double precision, AUTOINCREMENT -> bigserial).
-- Keeps the POS column names and integer ids so POS data maps across 1:1.
-- Not created: fuel_pumps, fuel_tanks, fuel_attendants, fuel_shifts,
-- fuel_tank_readings, fuel_drivers, fuel_audit - the server already has
-- pumps, tanks, attendants, shifts, tank_readings, drivers and audit_log.
-- pump_id / tank_id / staff_id / shift_id here are plain integers, no foreign keys.
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public."fuel_pump_items" (
  "pump_id" bigint NOT NULL,
  "item_id" bigint NOT NULL,
  CONSTRAINT fuel_pump_items_pkey PRIMARY KEY (pump_id, item_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_sales" (
  "id" bigserial NOT NULL,
  "created_at" text,
  "pump_id" bigint,
  "pump" text,
  "item_id" bigint,
  "item" text,
  "litres" double precision,
  "unit_price" bigint,
  "amount" bigint,
  "attendant_id" bigint,
  "attendant" text,
  "customer_id" bigint,
  "customer" text DEFAULT '',
  "vehicle" text DEFAULT '',
  "status" text DEFAULT 'PENDING',
  "sale_id" bigint,
  "cleared_at" text,
  "cleared_by" text,
  "clearing_id" bigint,
  "note" text DEFAULT '',
  "recorded_by" text DEFAULT '',
  "txn_ref" text,
  "mode" text DEFAULT 'POSTPAY',
  "nozzle_id" bigint,
  "preset_type" text DEFAULT '',
  "preset_value" double precision DEFAULT 0,
  "authorized_by" text DEFAULT '',
  "authorized_at" text,
  "completed_at" text,
  "pump_price" bigint,
  "price_ok" bigint DEFAULT 1,
  "paid" bigint DEFAULT 0,
  "assigned_to" text DEFAULT '',
  "assigned_id" text DEFAULT '',
  "till" text DEFAULT '',
  "held" bigint DEFAULT 0,
  "shift_id" bigint,
  "vehicle_id" bigint,
  "driver_id" bigint,
  "odometer" double precision,
  "cancel_code" text DEFAULT '',
  "settled_shift_id" bigint,
  CONSTRAINT fuel_sales_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_clearings" (
  "id" bigserial NOT NULL,
  "created_at" text,
  "kind" text,
  "attendant_id" bigint,
  "attendant" text,
  "customer_id" bigint,
  "customer" text DEFAULT '',
  "sale_id" bigint,
  "litres" double precision,
  "pumped" bigint,
  "expected" bigint,
  "received" bigint,
  "variance" bigint DEFAULT 0,
  "cashier" text,
  "note" text DEFAULT '',
  CONSTRAINT fuel_clearings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_nozzles" (
  "id" bigserial NOT NULL,
  "pump_id" bigint NOT NULL,
  "no" bigint NOT NULL,
  "item_id" bigint NOT NULL,
  "tank_id" bigint,
  "totalizer" double precision DEFAULT 0,
  "pump_price" bigint,
  "active" bigint DEFAULT 1,
  CONSTRAINT fuel_nozzles_pkey PRIMARY KEY (id),
  CONSTRAINT fuel_nozzles_pump_item_key UNIQUE (pump_id, item_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_pump_events" (
  "id" bigserial NOT NULL,
  "at" text,
  "pump_id" bigint,
  "nozzle_id" bigint,
  "kind" text,
  "detail" text DEFAULT '',
  "by_user" text DEFAULT '',
  CONSTRAINT fuel_pump_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_faults" (
  "id" bigserial NOT NULL,
  "pump_id" bigint,
  "kind" text,
  "description" text,
  "started_at" text,
  "resolved_at" text,
  "blocking" bigint DEFAULT 0,
  "reported_by" text,
  "resolved_by" text,
  "note" text DEFAULT '',
  CONSTRAINT fuel_faults_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_readings" (
  "id" bigserial NOT NULL,
  "at" text,
  "shift_id" bigint,
  "nozzle_id" bigint,
  "kind" text,
  "totalizer" double precision,
  "by_user" text,
  CONSTRAINT fuel_readings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_attendant_sessions" (
  "id" bigserial NOT NULL,
  "staff_id" bigint,
  "login_at" text,
  "logout_at" text,
  "shift_id" bigint,
  "via" text,
  CONSTRAINT fuel_attendant_sessions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_pump_tags" (
  "pump_id" bigint NOT NULL,
  "staff_id" bigint NOT NULL,
  "tagged_at" text,
  "via" text,
  CONSTRAINT fuel_pump_tags_pkey PRIMARY KEY (pump_id, staff_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_payments" (
  "id" bigserial NOT NULL,
  "at" text,
  "txn_id" bigint,
  "invoice_no" text DEFAULT '',
  "method" text,
  "provider" text DEFAULT '',
  "amount" bigint,
  "ref" text DEFAULT '',
  "status" text DEFAULT 'OK',
  "idem_key" text,
  "cashier" text,
  "shift_id" bigint,
  "sale_id" bigint,
  "customer_id" bigint,
  "note" text DEFAULT '',
  "reversed_by" text,
  "reversed_at" text,
  "reverse_reason" text,
  CONSTRAINT fuel_payments_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_idem" (
  "key" text NOT NULL,
  "at" text,
  "result" text,
  CONSTRAINT fuel_idem_pkey PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS public."fuel_provider_records" (
  "id" bigserial NOT NULL,
  "provider" text,
  "ref" text,
  "amount" bigint,
  "at" text,
  "imported_at" text,
  "matched_payment_id" bigint,
  CONSTRAINT fuel_provider_records_pkey PRIMARY KEY (id),
  CONSTRAINT fuel_provider_records_provider_ref_key UNIQUE (provider, ref)
);

CREATE TABLE IF NOT EXISTS public."fuel_deposits" (
  "id" bigserial NOT NULL,
  "at" text,
  "customer_id" bigint,
  "kind" text,
  "amount" bigint,
  "method" text,
  "ref" text DEFAULT '',
  "txn_id" bigint,
  "sale_id" bigint,
  "cashier" text,
  "shift_id" bigint,
  "note" text DEFAULT '',
  CONSTRAINT fuel_deposits_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_vouchers" (
  "id" bigserial NOT NULL,
  "code" text,
  "customer_id" bigint,
  "item_id" bigint,
  "value" bigint,
  "remaining" bigint,
  "expires" text,
  "status" text DEFAULT 'ACTIVE',
  "issued_at" text,
  "issued_by" text,
  "note" text DEFAULT '',
  CONSTRAINT fuel_vouchers_pkey PRIMARY KEY (id),
  CONSTRAINT fuel_vouchers_code_key UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS public."fuel_vehicles" (
  "id" bigserial NOT NULL,
  "customer_id" bigint,
  "plate" text,
  "make" text DEFAULT '',
  "tank_litres" double precision DEFAULT 0,
  "daily_litres" double precision DEFAULT 0,
  "weekly_litres" double precision DEFAULT 0,
  "monthly_litres" double precision DEFAULT 0,
  "txn_limit" bigint DEFAULT 0,
  "item_ids" text DEFAULT '[]',
  "hour_from" text DEFAULT '',
  "hour_to" text DEFAULT '',
  "min_gap_minutes" bigint DEFAULT 0,
  "last_odometer" double precision DEFAULT 0,
  "last_fill_at" text,
  "cost_center" text DEFAULT '',
  "rfid" text,
  "card_no" text,
  "otp_phone" text DEFAULT '',
  "active" bigint DEFAULT 1,
  "note" text DEFAULT '',
  CONSTRAINT fuel_vehicles_pkey PRIMARY KEY (id),
  CONSTRAINT fuel_vehicles_plate_key UNIQUE (plate)
);

CREATE TABLE IF NOT EXISTS public."fuel_contract_prices" (
  "customer_id" bigint NOT NULL,
  "item_id" bigint NOT NULL,
  "discount_per_litre" bigint DEFAULT 0,
  CONSTRAINT fuel_contract_prices_pkey PRIMARY KEY (customer_id, item_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_otps" (
  "id" bigserial NOT NULL,
  "vehicle_id" bigint,
  "code_hash" text,
  "expires_at" text,
  "used" bigint DEFAULT 0,
  "created_at" text,
  "item_id" bigint,
  "preset_type" text DEFAULT 'FULL',
  "preset_value" double precision DEFAULT 0,
  CONSTRAINT fuel_otps_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_cash_moves" (
  "id" bigserial NOT NULL,
  "at" text,
  "shift_id" bigint,
  "kind" text,
  "amount" bigint,
  "count" text,
  "staff_id" bigint,
  "from_name" text,
  "to_name" text,
  "ack_by" text,
  "note" text DEFAULT '',
  "by_user" text,
  CONSTRAINT fuel_cash_moves_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_deliveries" (
  "id" bigserial NOT NULL,
  "at" text,
  "tank_id" bigint,
  "item_id" bigint,
  "supplier" text DEFAULT '',
  "note_no" text DEFAULT '',
  "litres_received" double precision,
  "litres_measured" double precision,
  "before_l" double precision,
  "after_l" double precision,
  "temp_c" double precision,
  "cost_per_litre" bigint DEFAULT 0,
  "variance_l" double precision DEFAULT 0,
  "by_user" text,
  "note" text DEFAULT '',
  CONSTRAINT fuel_deliveries_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_price_changes" (
  "id" bigserial NOT NULL,
  "item_id" bigint,
  "old_price" bigint,
  "new_price" bigint,
  "effective_at" text,
  "status" text,
  "reason" text DEFAULT '',
  "requested_by" text,
  "requested_at" text,
  "decided_by" text,
  "decided_at" text,
  "applied_at" text,
  "stations" text DEFAULT 'THIS',
  CONSTRAINT fuel_price_changes_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_price_history" (
  "id" bigserial NOT NULL,
  "at" text,
  "item_id" bigint,
  "old_price" bigint,
  "new_price" bigint,
  "by_user" text,
  "change_id" bigint,
  "source" text DEFAULT 'CHANGE',
  CONSTRAINT fuel_price_history_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_cost_history" (
  "id" bigserial NOT NULL,
  "at" text,
  "item_id" bigint,
  "cost" bigint,
  "delivery_id" bigint,
  "litres" double precision,
  CONSTRAINT fuel_cost_history_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_lpg" (
  "size_kg" double precision NOT NULL,
  "full" bigint DEFAULT 0,
  "empty" bigint DEFAULT 0,
  "damaged" bigint DEFAULT 0,
  "deposit" bigint DEFAULT 0,
  "item_id" bigint,
  "reorder_full" bigint DEFAULT 0,
  CONSTRAINT fuel_lpg_pkey PRIMARY KEY (size_kg)
);

CREATE TABLE IF NOT EXISTS public."fuel_lpg_moves" (
  "id" bigserial NOT NULL,
  "at" text,
  "size_kg" double precision,
  "kind" text,
  "qty" bigint,
  "customer_id" bigint,
  "deposit" bigint DEFAULT 0,
  "note" text DEFAULT '',
  "by_user" text,
  CONSTRAINT fuel_lpg_moves_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_issues" (
  "id" bigserial NOT NULL,
  "at" text,
  "staff_id" bigint,
  "item_id" bigint,
  "qty" double precision,
  "returned" double precision DEFAULT 0,
  "status" text DEFAULT 'OPEN',
  "note" text DEFAULT '',
  "by_user" text,
  "closed_at" text,
  CONSTRAINT fuel_issues_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_targets" (
  "id" bigserial NOT NULL,
  "name" text DEFAULT '',
  "scope" text DEFAULT 'STATION',
  "ref" text DEFAULT '',
  "metric" text,
  "period" text,
  "value" double precision DEFAULT 0,
  "active" bigint DEFAULT 1,
  "created_at" text,
  "created_by" text DEFAULT '',
  CONSTRAINT fuel_targets_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_account_flags" (
  "customer_id" bigint NOT NULL,
  "status" text DEFAULT 'ACTIVE',
  "reason" text DEFAULT '',
  "at" text,
  "by_user" text DEFAULT '',
  CONSTRAINT fuel_account_flags_pkey PRIMARY KEY (customer_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_delivery_checks" (
  "id" bigserial NOT NULL,
  "at" text,
  "tank_id" bigint,
  "delivery_id" bigint,
  "supplier" text DEFAULT '',
  "note_no" text DEFAULT '',
  "truck_plate" text DEFAULT '',
  "driver_name" text DEFAULT '',
  "driver_id_no" text DEFAULT '',
  "product" text DEFAULT '',
  "litres_ordered" double precision,
  "litres_on_note" double precision,
  "seals" text DEFAULT '[]',
  "checks" text DEFAULT '{}',
  "density" double precision,
  "temp_c" double precision,
  "water_mm" double precision,
  "status" text DEFAULT 'PASSED',
  "failures" text DEFAULT '[]',
  "warnings" text DEFAULT '[]',
  "decision" text DEFAULT '',
  "decided_by" text DEFAULT '',
  "decided_at" text,
  "decision_note" text DEFAULT '',
  "checked_by" text DEFAULT '',
  "note" text DEFAULT '',
  CONSTRAINT fuel_delivery_checks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."fuel_recon_notes" (
  "key" text NOT NULL,
  "status" text NOT NULL,
  "note" text DEFAULT '',
  "by_user" text DEFAULT '',
  "at" text,
  CONSTRAINT fuel_recon_notes_pkey PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS public."fuel_delivery_invoices" (
  "id" bigserial NOT NULL,
  "delivery_id" bigint NOT NULL,
  "invoice_no" text NOT NULL,
  "litres_invoiced" double precision NOT NULL,
  "amount" bigint DEFAULT 0,
  "at" text,
  "by_user" text DEFAULT '',
  "decision" text DEFAULT '',
  "decided_by" text DEFAULT '',
  "decided_at" text,
  "decision_note" text DEFAULT '',
  CONSTRAINT fuel_delivery_invoices_pkey PRIMARY KEY (id),
  CONSTRAINT fuel_delivery_invoices_delivery_key UNIQUE (delivery_id)
);

CREATE TABLE IF NOT EXISTS public."fuel_calibration_log" (
  "id" bigserial NOT NULL,
  "at" text,
  "tank_id" bigint,
  "factor" double precision,
  "reason" text DEFAULT '',
  "by_user" text DEFAULT '',
  "old_strapping" text DEFAULT '[]',
  CONSTRAINT fuel_calibration_log_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS fuel_sales_status ON public.fuel_sales (status, attendant_id);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_sales_ref ON public.fuel_sales (txn_ref) WHERE txn_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS fuel_pump_events_pump ON public.fuel_pump_events (pump_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_payments_idem ON public.fuel_payments (idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS fuel_payments_ref ON public.fuel_payments (ref);
CREATE INDEX IF NOT EXISTS fuel_delivery_checks_note ON public.fuel_delivery_checks (note_no, supplier);
