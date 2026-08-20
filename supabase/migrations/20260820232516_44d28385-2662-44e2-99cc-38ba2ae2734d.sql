-- Re-vincula a conta Google Ads correta ao usuário correto para o site Jardim Astral
UPDATE public.account_site_links 
SET user_id = '1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9' 
WHERE site_id = '4737bd19-5996-48a8-a7bb-406cfdbaa741' 
AND user_id = '70755913-c3fa-4007-a36c-941c50e932b5';