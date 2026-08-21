import pg from 'pg';
const c=new pg.Client({connectionString:'postgresql://razorveda_migrator:localdev@127.0.0.1:5433/postgres'});
await c.connect();
await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='razorveda' AND pid<>pg_backend_pid()`);
await c.query('DROP DATABASE IF EXISTS razorveda'); await c.query('CREATE DATABASE razorveda');
console.log('recreated'); await c.end();
