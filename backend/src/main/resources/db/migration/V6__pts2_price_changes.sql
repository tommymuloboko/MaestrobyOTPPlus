-- Pump prices sent to a site's PTS-2: immediate changes, changes scheduled on the controller, and cancellations.
create table pts2_price_changes (fuel_grade_id integer not null, schedule_id integer, previous_price numeric(38,3), new_price numeric(38,3) not null, effective_at timestamp(6) not null, at timestamp(6) with time zone not null, id uuid not null, site_code varchar(255) not null, fuel_grade_name varchar(255), mode varchar(255) not null, changed_by varchar(255) not null, primary key (id));
create index pts2_price_changes_site on pts2_price_changes (site_code, at);
