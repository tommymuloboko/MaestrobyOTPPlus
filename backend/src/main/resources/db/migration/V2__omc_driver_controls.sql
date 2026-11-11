-- OMC console: driver verification and fuel-access suspension.
alter table drivers add column verified boolean not null default false;
alter table drivers add column verified_by varchar(255);
alter table drivers add column verified_at timestamp(6) with time zone;
alter table drivers add column access_suspended boolean not null default false;
alter table drivers add column suspended_reason varchar(255);
