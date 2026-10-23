select id, display_name, access_role, status
from employee
where access_role = 'ceo' or display_name ilike '%hemanth%' or display_name ilike '%priya%'
order by access_role, display_name;