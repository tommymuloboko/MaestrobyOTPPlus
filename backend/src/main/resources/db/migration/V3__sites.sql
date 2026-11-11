-- Sites become data instead of a fixed list, each tied to the unique ID of its PTS-2 forecourt controller.
-- The three demo sites are inserted by the application on start-up when they are missing.
create table sites (latitude float(53) not null, longitude float(53) not null, created_at timestamp(6) with time zone not null, id uuid not null, code varchar(255) not null unique, kind varchar(255) not null, name varchar(255) not null, pts2_id varchar(255) not null unique, primary key (id));
