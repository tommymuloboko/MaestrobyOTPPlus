-- Network connection to each site's PTS-2 controller, used to pull live tank (probe) readings.
create table pts2_connections (enabled boolean not null, updated_at timestamp(6) with time zone not null, id uuid not null, site_code varchar(255) not null unique, url varchar(255) not null, username varchar(255) not null, password varchar(255) not null, primary key (id));
