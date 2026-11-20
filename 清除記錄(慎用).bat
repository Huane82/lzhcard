git checkout --orphan temp_branch
git add -A
git commit -m "Clean start"
git branch -f main HEAD && git checkout main && git branch -D temp_branch
git push -f origin main
