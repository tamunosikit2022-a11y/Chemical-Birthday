create table if not exists members (
  id bigint generated always as identity primary key,
  name text not null,
  dob date not null,
  phone text,
  photo text,
  created_at timestamptz not null default now()
);
-- Row level security on with no policies: only the server key can read/write.
alter table members enable row level security;
