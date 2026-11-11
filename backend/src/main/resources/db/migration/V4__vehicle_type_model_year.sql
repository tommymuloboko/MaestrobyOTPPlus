-- Vehicle register: type, model and year of manufacture.
alter table vehicles add column vehicle_type varchar(255);
alter table vehicles add column model varchar(255);
alter table vehicles add column model_year integer;
